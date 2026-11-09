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
      if (!sql.startsWith("INSERT INTO forecast_worker_health")) writes++;
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
it("bounds result work and rotates toward the least recently checked event", async () => {
  const queries: { sql: string; values: unknown }[] = [];
  const pool = {
    query: async (sql: string, values: unknown) => {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as Pool;
  expect(await refreshNbaForecastResults(pool, undefined, 2)).toMatchObject({
    checked: 0,
  });
  expect(queries[0]?.sql).toContain("ORDER BY checked_at");
  expect(queries[0]?.values).toEqual([2]);
  await expect(refreshNbaForecastResults(pool, undefined, 0)).rejects.toThrow(
    "INVALID_RESULT_BATCH",
  );
});
