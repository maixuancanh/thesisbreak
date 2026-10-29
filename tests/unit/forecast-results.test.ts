import { expect, it } from "vitest";
import type { Pool } from "pg";
import { refreshNbaForecastResults } from "../../packages/integrations/src/forecast-results";
const target = {
  event_id: "espn:1",
  home: "ATL",
  away: "MIA",
  scheduled_at: new Date("2026-10-28T23:00:00Z"),
};
const official = {
  state: "available" as const,
  game: {
    gameId: "0022600132",
    eventDate: "2026-10-28",
    scheduledAt: "2026-10-28T23:00:00.000Z",
    homeTeam: "ATL",
    awayTeam: "MIA",
    homeTeamId: 1,
    awayTeamId: 2,
    homeScore: 117,
    awayScore: 129,
    status: "final" as const,
    finalizedAt: null,
    lineupConfirmed: true,
    starters: [],
  },
  provenance: {
    sourceUrl: "https://www.nba.com/game/0022600132/box-score",
    rawSha256: "a".repeat(64),
    retrievedAt: "2026-10-29T01:30:00Z",
    sourceUpdatedAt: null,
    sourceTimestampRaw: null,
    provider: "nba_official" as const,
    officialNba: true as const,
  },
  scheduleProvenance: null,
  endedAt: null,
  attempts: [],
};
it("does not write results when official source unavailable or tipoff mismatches", async () => {
  let writes = 0;
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith("SELECT DISTINCT")) return { rows: [target] };
      writes++;
      return { rows: [] };
    },
  } as unknown as Pool;
  const result = await refreshNbaForecastResults(pool, async () => ({
    ...official,
    state: "unavailable",
    game: null,
    provenance: null,
  }));
  expect(result.unavailable).toBe(1);
  expect(writes).toBe(0);
  await refreshNbaForecastResults(pool, async () => ({
    ...official,
    game: { ...official.game, scheduledAt: "2026-10-28T22:00:00Z" },
  }));
  expect(writes).toBe(0);
});
