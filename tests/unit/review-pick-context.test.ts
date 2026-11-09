import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  reviews: vi.fn(),
  research: vi.fn(),
}));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("pg", () => ({
  Pool: class {
    query = mocks.query;
  },
}));
vi.mock("../../apps/web/lib/server/auth", async () => ({
  ...(await vi.importActual<
    typeof import("../../apps/web/lib/server/auth-policy")
  >("../../apps/web/lib/server/auth-policy")),
  requireUser: async () => ({ id: "owner" }),
  authConfigured: () => true,
  assertMutationOrigin: () => {},
}));
vi.mock("../../packages/db/src/pick-impact", () => ({
  listPickReviews: mocks.reviews,
}));
vi.mock("../../packages/db/src/agent-runs", async () => ({
  ...(await vi.importActual<typeof import("../../packages/db/src/agent-runs")>(
    "../../packages/db/src/agent-runs",
  )),
  claimRun: async () => ({ id: "run", fresh: true }),
  finishRun: async () => {},
  conversationHistory: async () => [],
}));
vi.mock("../../packages/agent/src/runtime", () => ({
  runResearch: mocks.research,
  recentHistory: () => [],
}));
vi.mock("../../apps/web/lib/server/live-catalog", () => ({
  readLiveCatalog: async () => ({
    data: [
      {
        id: "TEST",
        platform: "kalshi",
        question: "Synthetic market",
        outcomes: [
          { name: "Yes", price: 0.5 },
          { name: "No", price: 0.5 },
        ],
        rules: null,
        closeTime: null,
        fetchedAt: "2026-11-02T00:00:00Z",
        updatedAt: null,
        sourceUrl: null,
      },
    ],
    nextCursor: null,
    provider: "kalshi-public",
    fetchedAt: "2026-11-02T00:00:00Z",
  }),
}));
import { agentSend } from "../../apps/web/lib/server/agent-service";
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({
    DATABASE_URL: "postgres://offline-test",
    LLM_BASE_URL: "https://model.test/v1",
    LLM_API_KEY: "fixture",
    LLM_MODEL: "fixture",
    MEMWAL_ACCOUNT_ID: "",
    MEMWAL_DELEGATE_KEY: "",
    PROCEDURE_VERSION: "",
  }))
    vi.stubEnv(key, value);
  mocks.reviews.mockResolvedValue({
    items: [{ id: "review", pickId: "selected-older-pick" }],
  });
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith("SELECT id FROM picks")
      ? [{ id: "selected-older-pick" }]
      : [],
  }));
  mocks.research.mockImplementation(
    async (
      _input: unknown,
      dependencies: {
        readPick: () => Promise<unknown>;
        readComparison: () => Promise<unknown>;
      },
    ) => {
      await dependencies.readPick();
      await dependencies.readComparison();
      return {};
    },
  );
});
afterEach(() => vi.unstubAllEnvs());
it("binds both current pick and saved comparison reads to the owner-selected review pick", async () => {
  const response = await agentSend(
    new Request("https://app.test/api/agent/messages", {
      method: "POST",
      body: JSON.stringify({
        platform: "kalshi",
        nativeId: "TEST",
        provider: "public",
        message: "Review my selected pick",
        requestId: "dbf74027-3a1b-4649-b9cd-25fdc02f5a02",
        reviewId: "review",
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(mocks.research).toHaveBeenCalledOnce();
  const selectedReads = mocks.query.mock.calls.filter(([sql]) =>
    sql.includes("ORDER BY p.created_at DESC LIMIT 1"),
  );
  expect(selectedReads).toHaveLength(2);
  for (const [sql, parameters] of selectedReads) {
    expect(sql).toContain("p.id::text=$4");
    expect(parameters).toEqual([
      "owner",
      "kalshi",
      "TEST",
      "selected-older-pick",
    ]);
  }
});
