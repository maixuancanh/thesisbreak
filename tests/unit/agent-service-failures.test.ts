import { it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  catalog: vi.fn(),
  finish: vi.fn(),
  research: vi.fn(),
  planner: vi.fn(),
  register: vi.fn(),
}));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("../../apps/web/lib/server/auth", async () => ({
  ...(await import("../../apps/web/lib/server/auth-policy")),
  requireUser: async () => ({ id: "owner" }),
  assertMutationOrigin: () => {},
}));
vi.mock("pg", () => ({ Pool: class {} }));
vi.mock("../../apps/web/lib/server/pick-intelligence", () => ({
  readPickIntelligence: async () => ({
    rules: { state: "missing", sourceUrl: null, observedAt: "2026-01-01T00:00:00Z", excerpts: [], previous: null, comparison: "requires_exact_event_outcome_and_rules_review" },
    connections: [], connectionsState: "checked", scannedPicks: 0, contextOnly: true,
  }),
}));
vi.mock("../../packages/db/src/agent-runs", async (original) => ({
  ...(await original<typeof import("../../packages/db/src/agent-runs")>()),
  claimRun: mocks.claim,
  finishRun: mocks.finish,
  conversationHistory: async () => [],
}));
vi.mock("../../apps/web/lib/server/live-catalog", async (original) => ({
  ...(await original<
    typeof import("../../apps/web/lib/server/live-catalog")
  >()),
  readLiveCatalog: mocks.catalog,
}));
vi.mock("../../packages/agent/src/runtime", async (original) => ({
  ...(await original<typeof import("../../packages/agent/src/runtime")>()),
  runResearch: mocks.research,
}));
vi.mock("../../packages/agent/src/provider", () => ({
  createOfficialPlanner: mocks.planner,
  createOfficialGenerator: vi.fn(),
}));
vi.mock("../../apps/web/lib/server/run-control-service", () => ({
  registerRunAbort: mocks.register,
  unregisterRunAbort: vi.fn(),
}));
import { agentSend } from "../../apps/web/lib/server/agent-service";
const request = (extra = {}) =>
  new Request("https://fixture.test/api/agent/messages", {
    method: "POST",
    body: JSON.stringify({
      platform: "kalshi",
      nativeId: "TEST",
      provider: "public",
      message: "explain",
      requestId: "ab754de3-b981-4347-9daa-72b7ad8e0692",
      ...extra,
    }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://offline");
  vi.stubEnv("LLM_BASE_URL", "https://fixture.test/v1");
  vi.stubEnv("LLM_API_KEY", "offline");
  vi.stubEnv("LLM_MODEL", "offline");
  mocks.claim.mockResolvedValue({
    fresh: true,
    id: "ab754de3-b981-4347-9daa-72b7ad8e0692",
  });
  mocks.finish.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("classifies malformed upstream market output as server failure, not invalid user input", async () => {
  mocks.catalog.mockResolvedValue({ data: "private upstream payload" });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await agentSend(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "AGENT_UNAVAILABLE" });
  expect(log).toHaveBeenCalledWith("agent_request_failed", {
    stage: "market_read",
    category: "schema_validation",
    runId: "ab754de3-b981-4347-9daa-72b7ad8e0692",
    status: 503,
  });
  expect(mocks.finish).toHaveBeenCalledWith(
    expect.anything(),
    "owner",
    expect.any(String),
    { error: "AGENT_UNAVAILABLE" },
    "failed",
  );
});
it("does not log error messages, arbitrary codes, names, stack frames or cause payloads", async () => {
  mocks.catalog.mockRejectedValue(
    Object.assign(Error("prompt secret https://private/?key=secret"), {
      name: "SECRET_PAYLOAD",
      code: "SECRET_CODE",
      stack: "at SECRET_LOCATION",
      cause: Object.assign(Error("private"), { statusCode: 429 }),
    }),
  );
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await agentSend(request())).status).toBe(503);
  expect(log).toHaveBeenCalledWith("agent_request_failed", {
    stage: "market_read",
    category: "upstream_rate_limit",
    runId: "ab754de3-b981-4347-9daa-72b7ad8e0692",
    status: 503,
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
});
it("still returns client validation errors before claiming a run", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await agentSend(request({ message: "" }))).status).toBe(400);
  expect(mocks.claim).not.toHaveBeenCalled();
});

it("passes the registered run cancellation signal into planning", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.catalog.mockResolvedValue({
    data: [
      {
        id: "TEST",
        platform: "kalshi",
        question: "Fixture?",
        outcomes: [
          { name: "Yes", price: null },
          { name: "No", price: null },
        ],
        rules: null,
        closeTime: null,
        fetchedAt: "2026-01-01T00:00:00Z",
        updatedAt: null,
        sourceUrl: null,
      },
    ],
    nextCursor: null,
    provider: "kalshi-public",
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  mocks.planner.mockReturnValue(async () => ({ tools: [] }));
  mocks.research.mockImplementation(async (input, deps) => {
    await deps.plan(input);
    return {};
  });
  expect((await agentSend(request())).status).toBe(200);
  const controller = mocks.register.mock.calls[0]![2] as AbortController;
  expect(mocks.planner.mock.calls[0]![2]).toBe(controller.signal);
});
