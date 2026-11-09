import { beforeEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  history: vi.fn(),
  resolve: vi.fn(),
  send: vi.fn(),
  finish: vi.fn(),
}));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("../../apps/web/lib/server/auth", async () => {
  const p = await import("../../apps/web/lib/server/auth-policy");
  return {
    ...p,
    requireUser: async () => ({ id: "owner" }),
    assertMutationOrigin: () => {},
  };
});
vi.mock("../../apps/web/lib/server/chat-session-service", () => ({
  sessionDb: () => ({ query: mocks.query }),
}));
vi.mock("../../packages/db/src/chat-sessions", () => ({
  chatHistory: mocks.history,
  recallChatMemories: async () => [],
}));
vi.mock("../../packages/db/src/agent-runs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../packages/db/src/agent-runs")
  >()),
  finishRun: mocks.finish,
}));
vi.mock("../../packages/agent/src/provider", () => ({
  resolveConversationMarket: mocks.resolve,
  createOfficialGenerator: () => vi.fn(),
}));
vi.mock("../../apps/web/lib/server/agent-service", () => ({
  agentSend: mocks.send,
}));
vi.mock("../../apps/web/lib/server/run-control-service", () => ({
  registerRunAbort: vi.fn(),
  unregisterRunAbort: vi.fn(),
}));
import { sessionMessage } from "../../apps/web/lib/server/session-message-service";
const input = {
  sessionId: "916a5c09-1d27-4126-9044-d76558913d50",
  requestId: "ab754de3-b981-4347-9daa-72b7ad8e0692",
  provider: "public",
  message: "What about Lakers?",
};
const request = (extra = {}) =>
  new Request("http://localhost/api/agent/sessions/message", {
    method: "POST",
    body: JSON.stringify({ ...input, ...extra }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MEMWAL_ACCOUNT_ID", "");
  vi.stubEnv("MEMWAL_DELEGATE_KEY", "");
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.history.mockResolvedValue([]);
  mocks.resolve.mockResolvedValue(null);
});
it("rejects inaccessible sessions before any model or memory read", async () => {
  mocks.history.mockRejectedValue(Error("SESSION_NOT_FOUND"));
  expect((await sessionMessage(request())).status).toBe(404);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});
it("replays a completed request without a second model invocation", async () => {
  mocks.query.mockResolvedValue({
    rows: [
      {
        id: "run",
        conversation_id: input.sessionId,
        message: input.message,
        provider: input.provider,
        status: "completed",
        result: { reply: "saved" },
      },
    ],
  });
  const r = await sessionMessage(request());
  expect((await r.json()).result).toEqual({ reply: "saved" });
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("rejects reuse of another session request", async () => {
  mocks.query.mockResolvedValue({
    rows: [
      {
        conversation_id: "other",
        message: input.message,
        provider: input.provider,
      },
    ],
  });
  expect((await sessionMessage(request())).status).toBe(409);
});
it("resolves a market discussed earlier and preserves the independent session ID", async () => {
  mocks.history.mockResolvedValue([
    {
      platform: "kalshi",
      native_id: "LAKERS",
      result: { marketQuestion: "Lakers win?" },
    },
  ]);
  mocks.resolve.mockResolvedValue({
    platform: "kalshi",
    nativeId: "LAKERS",
    question: "Lakers win?",
  });
  mocks.send.mockResolvedValue(Response.json({ ok: true }));
  const r = await sessionMessage(request());
  expect(r.status).toBe(200);
  const delegated = await (mocks.send.mock.calls[0]![0] as Request).json();
  expect(delegated.sessionId).toBe(input.sessionId);
  expect(delegated.nativeId).toBe("LAKERS");
});
it("rejects a partial market identity and untrusted context", async () => {
  expect((await sessionMessage(request({ platform: "kalshi" }))).status).toBe(
    400,
  );
  expect(
    (await sessionMessage(request({ context: "fake evidence" }))).status,
  ).toBe(400);
});

it("uses an explicit market without invoking a failing history resolver", async () => {
  mocks.history.mockResolvedValue([
    {
      platform: "kalshi",
      native_id: "OLD",
      result: { marketQuestion: "Old?" },
    },
  ]);
  mocks.resolve.mockRejectedValue(Error("provider down"));
  mocks.send.mockResolvedValue(Response.json({ ok: true }));
  const response = await sessionMessage(
    request({ platform: "polymarket", nativeId: "EXPLICIT" }),
  );
  expect(response.status).toBe(200);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(await mocks.send.mock.calls[0]![0].json()).toMatchObject({
    platform: "polymarket",
    nativeId: "EXPLICIT",
  });
});

it("reports a history database outage as unavailable instead of missing session", async () => {
  mocks.history.mockRejectedValue(
    Object.assign(Error("private connection details"), { code: "08006" }),
  );
  const response = await sessionMessage(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "SESSION_MESSAGE_UNAVAILABLE",
  });
});

it("reports resolver schema failures as server failures and logs only safe diagnostics", async () => {
  const { z } = await import("zod");
  const failure = z.object({ secret: z.string() }).safeParse({ secret: 123 });
  mocks.history.mockResolvedValue([
    { platform: "kalshi", native_id: "OLD", result: {} },
  ]);
  mocks.resolve.mockRejectedValue(failure.error);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await sessionMessage(
      request({ message: "Explain that market" }),
    );
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledWith("session_message_failed", {
      stage: "market_resolution",
      category: "schema_validation",
      runId: null,
      status: 503,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  } finally {
    log.mockRestore();
  }
});

it("caps session body bytes before reading the entire stream", async () => {
  let cancelled = false;
  let chunks = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (chunks++ === 0)
          controller.enqueue(new TextEncoder().encode("x".repeat(17000)));
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response = await sessionMessage(
    new Request("http://localhost/api/agent/sessions/message", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit),
  );
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(mocks.history).not.toHaveBeenCalled();
});

it("asks for clarification when a verified alias conflicts with the selected market", async () => {
  mocks.history.mockResolvedValue([
    {
      platform: "kalshi",
      native_id: "LAKERS",
      result: { marketQuestion: "Lakers win?" },
    },
  ]);
  mocks.send.mockResolvedValue(Response.json({ ok: true }));
  const response = await sessionMessage(
    request({ platform: "polymarket", nativeId: "EXPLICIT" }),
  );
  expect(response.status).toBe(422);
  expect((await response.json()).error).toBe(
    "MARKET_REFERENCE_CLARIFICATION_REQUIRED",
  );
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("keeps an explicit historical market even when another market is in session history", async () => {
  mocks.history.mockResolvedValue([
    {
      platform: "kalshi",
      native_id: "OLD",
      created_at: "2026-10-01T00:00:00Z",
      result: { marketQuestion: "Old?" },
    },
  ]);
  mocks.resolve.mockRejectedValue(Error("unavailable"));
  mocks.send.mockResolvedValue(Response.json({ ok: true }));
  const response = await sessionMessage(
    request({
      platform: "polymarket",
      nativeId: "EXPLICIT",
      message: "Explain that market as of 2026-10-29T12:30:00+07:00",
    }),
  );
  expect(response.status).toBe(200);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(await mocks.send.mock.calls[0]![0].json()).toMatchObject({
    nativeId: "EXPLICIT",
  });
});
