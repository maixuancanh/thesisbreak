import { expect, it } from "vitest";
import type { Pool } from "pg";
import { loadObservedHistory } from "../../packages/integrations/src/forecast-observations";

const scoreboard =
  "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261030&limit=100";
const retrieved_at = "2026-10-30T21:55:02.459Z";
function database(rows: unknown[]) {
  return { query: async () => ({ rows }) } as unknown as Pool;
}

it("does not parse stored ESPN event summaries as scoreboard history", async () => {
  const pool = database([
    { source_url: scoreboard, retrieved_at, payload: { events: [] } },
    {
      source_url:
        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401909277",
      retrieved_at,
      payload: { header: { id: "401909277" }, boxscore: {} },
    },
  ]);
  await expect(
    loadObservedHistory(pool, new Date("2026-10-31T00:00:00Z")),
  ).resolves.toEqual([]);
});

it("still rejects malformed snapshots from the expected scoreboard endpoint", async () => {
  const pool = database([
    { source_url: scoreboard, retrieved_at, payload: {} },
  ]);
  await expect(
    loadObservedHistory(pool, new Date("2026-10-31T00:00:00Z")),
  ).rejects.toThrow();
});
