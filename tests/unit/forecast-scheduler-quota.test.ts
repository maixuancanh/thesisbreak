import { expect, it, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
const mocks = vi.hoisted(() => ({
  bookmakers: vi.fn(async () => ({ state: "available", events: [] })),
}));
vi.mock("../../packages/integrations/src/forecast-bookmaker", () => ({
  readForecastBookmakers: mocks.bookmakers,
  matchedBookmakerBaseline: vi.fn(),
}));
vi.mock("../../packages/integrations/src/forecast-observations", () => ({
  loadObservedHistory: vi.fn(async () => []),
  persistNbaObservation: vi.fn(),
}));
import { captureDueForecasts } from "../../packages/integrations/src/forecast-scheduler";
beforeEach(() => vi.clearAllMocks());
function database(existing: boolean) {
  return {
    query: async (sql: string) => ({
      rows: sql.includes("clock_timestamp")
        ? [{ t: new Date("2026-10-29T06:00:00Z") }]
        : sql.includes("nba_forecast_subscriptions")
          ? [{ user_id: "owner", memory_consent: true }]
          : sql.includes("SELECT user_id,event_id,horizon") && existing
            ? [{ user_id: "owner", event_id: "espn:1", horizon: "T24h" }]
            : [],
    }),
  } as unknown as Pool;
}
const event = {
  eventId: "espn:1",
  scheduledAt: "2026-10-30T06:00:00Z",
  homeTeam: "BOS",
  awayTeam: "BKN",
  status: "pending" as const,
  homeScore: null,
  awayScore: null,
  retrievedAt: "2026-10-29T06:00:00Z",
  sourceUrl: "https://www.espn.com/nba/game/_/gameId/1",
  provider: "espn_public" as const,
  officialNba: false as const,
  lineupConfirmed: false as const,
};
it("spends no bookmaker credits outside capture windows", async () => {
  expect(
    await captureDueForecasts(database(false), async () => [
      { ...event, scheduledAt: "2026-10-30T07:00:00Z" },
    ]),
  ).toMatchObject({ captured: 0 });
  expect(mocks.bookmakers).not.toHaveBeenCalled();
});
it("spends no bookmaker credits when all subscribed forecasts already exist", async () => {
  expect(
    await captureDueForecasts(database(true), async () => [event]),
  ).toMatchObject({ captured: 0 });
  expect(mocks.bookmakers).not.toHaveBeenCalled();
});
