import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn(), query: vi.fn() }));
vi.mock("pg", () => ({
  Pool: class {
    query = m.query;
  },
}));
vi.mock("../../apps/web/lib/server/auth", () => ({
  requireUser: m.user,
  assertMutationOrigin: vi.fn(),
  AuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("../../packages/db/src/forecast-ledger", () => ({
  listNbaForecastLedger: m.list,
}));
import { GET } from "../../apps/web/app/api/forecasts/route";
import { AuthError } from "../../apps/web/lib/server/auth";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://test");
  m.user.mockResolvedValue({ id: "owner" });
  m.query.mockResolvedValue({ rows: [] });
});
it("preserves authenticated owner/live namespace boundary", async () => {
  m.user.mockRejectedValueOnce(new AuthError(401, "UNAUTHENTICATED"));
  expect((await GET()).status).toBe(401);
  expect(m.list).not.toHaveBeenCalled();
});
it("adds scorecards for all checkpoints, preserving unresolved and abstained counts", async () => {
  const forecast = {
    eventId: "a",
    homeTeam: "A",
    awayTeam: "B",
    horizon: "T24h",
    methodVersion: "elo-v1",
    scheduledAt: "2026-10-02T00:00:00Z",
    probability: 0.8,
    baselineProbability: 0.5,
    evidence: [],
  };
  m.list.mockResolvedValue([
    {
      id: "a",
      capturedAt: "2026-10-01T00:00:00Z",
      forecast,
      result: {
        status: "final",
        resolvedAt: "2026-10-02T03:00:00Z",
        retrievedAt: "2026-10-02T04:00:00Z",
        winner: "A",
      },
    },
    {
      id: "b",
      capturedAt: "2026-10-01T00:00:00Z",
      forecast: { ...forecast, eventId: "b", probability: null },
      result: null,
    },
  ]);
  const r = await GET();
  expect(r.status).toBe(200);
  expect(m.list).toHaveBeenCalledWith(expect.anything(), "owner", "live");
  const data = await r.json();
  expect(data.scorecards[0].counts).toMatchObject({
    capturedEvents: 2,
    settledEvents: 1,
    abstainedEvents: 1,
    unresolvedEvents: 1,
  });
  expect(data.scorecards[0].improvementDemonstrated).toBe(false);
  expect(data.rows).toHaveLength(2);
});
