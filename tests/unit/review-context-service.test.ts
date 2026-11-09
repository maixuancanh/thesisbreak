import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  reviews: vi.fn(),
  history: vi.fn(),
  send: vi.fn(),
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
vi.mock("../../packages/db/src/pick-impact", () => ({
  listPickReviews: mocks.reviews,
}));
vi.mock("../../packages/agent/src/provider", () => ({
  resolveConversationMarket: vi.fn(),
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
import { agentMessageSchema } from "../../packages/db/src/agent-runs";
const input = {
  sessionId: "916a5c09-1d27-4126-9044-d76558913d50",
  requestId: "ab754de3-b981-4347-9daa-72b7ad8e0692",
  provider: "public",
  message: "Discuss this source change",
  reviewId: "review1",
};
const req = (extra = {}) =>
  new Request("http://localhost/api/agent/sessions/message", {
    method: "POST",
    body: JSON.stringify({ ...input, ...extra }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MEMWAL_ACCOUNT_ID", "");
  vi.stubEnv("MEMWAL_DELEGATE_KEY", "");
  mocks.reviews.mockResolvedValue({
    items: [{ id: "review1", pickId: "pick1" }],
  });
  mocks.history.mockResolvedValue([]);
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("FROM picks")
      ? [{ platform: "kalshi", native_id: "KXNBAGAME-TEST" }]
      : [],
  }));
  mocks.send.mockResolvedValue(Response.json({ ok: true }));
});
describe("selected review stays owner-bound in the active chat", () => {
  it("derives the exact market from the owned review without a selected market", async () => {
    expect((await sessionMessage(req())).status).toBe(200);
    expect(mocks.reviews).toHaveBeenCalledWith(expect.anything(), "owner", {
      reviewId: "review1",
    });
    const body = await (mocks.send.mock.calls[0]![0] as Request).json();
    expect(body).toMatchObject({
      sessionId: input.sessionId,
      reviewId: "review1",
      platform: "kalshi",
      nativeId: "KXNBAGAME-TEST",
    });
  });
  it("returns404 for another owner's review and never delegates", async () => {
    mocks.reviews.mockResolvedValue({ items: [] });
    const response = await sessionMessage(req({ reviewId: "foreign-review" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "REVIEW_NOT_FOUND" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rejects a mismatching selected market", async () => {
    const response = await sessionMessage(
      req({ platform: "kalshi", nativeId: "OTHER" }),
    );
    expect(response.status).toBe(409);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rejects current review context in historical reconstruction", async () => {
    const response = await sessionMessage(
      req({ message: "What was known as of 2026-10-01T00:00:00Z?" }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "REVIEW_CONTEXT_NOT_AVAILABLE_FOR_HISTORICAL_REQUEST",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rejects changed reviewId under an existing requestId", async () => {
    const original = agentMessageSchema.parse({
      ...input,
      platform: "kalshi",
      nativeId: "KXNBAGAME-TEST",
    });
    const prior = {
      id: "run",
      conversation_id: input.sessionId,
      message: input.message,
      provider: input.provider,
      platform: "kalshi",
      native_id: "KXNBAGAME-TEST",
      status: "completed",
      result: {},
      payload_hash: createHash("sha256")
        .update(JSON.stringify(original))
        .digest("hex"),
    };
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("FROM picks")
        ? [{ platform: "kalshi", native_id: "KXNBAGAME-TEST" }]
        : sql.includes("FROM agent_runs")
          ? [prior]
          : [],
    }));
    const response = await sessionMessage(req({ reviewId: "review2" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "REQUEST_ID_REUSED" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
