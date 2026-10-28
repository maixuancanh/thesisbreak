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
vi.mock("../../packages/db/src/agent-runs", () => ({
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
