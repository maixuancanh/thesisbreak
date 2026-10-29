import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  fetchNbaHistory,
  historyForElo,
} from "../packages/integrations/src/news/nba-history";

// Public data only. Usage: tsx scripts/check-nba-history.ts [start YYYY-MM-DD] [end YYYY-MM-DD]
// Snapshots are cached by content hash; the manifest retains when each result was observed.
const now = new Date();
const endDate =
  process.argv[3] ??
  new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
const startDate =
  process.argv[2] ??
  new Date(Date.parse(`${endDate}T00:00:00Z`) - 29 * 86400000)
    .toISOString()
    .slice(0, 10);
const directory = resolve(".local/nba-history");
await mkdir(resolve(directory, "snapshots"), { recursive: true });
const result = await fetchNbaHistory({
  startDate,
  endDate,
  onSnapshot: async (snapshot) => {
    await writeFile(
      resolve(directory, "snapshots", `${snapshot.sha256}.json`),
      snapshot.body,
      "utf8",
    );
  },
});
const completedAt = new Date().toISOString();
const elo = historyForElo(result.records, completedAt);
const manifest = {
  schemaVersion: "nba-public-history-v1",
  startDate,
  endDate,
  completedAt,
  ...result,
  snapshots: result.snapshots.map((snapshot) => ({
    ...snapshot,
    cacheFile: `snapshots/${snapshot.sha256}.json`,
  })),
  availabilitySemantics:
    "resolvedAt is finalObservedAt from actual retrieval, not actual game end or original result publication; no historical pre-event forecasts created",
  restSemantics:
    "full rest days = max(0, floor((target start - previous played start)/24h) - 1); unknown prior starts excluded; date coverage must be complete",
  eloEligible: elo.games.length,
  excluded: elo.excluded,
};
const artifact = resolve(directory, "history.json");
await writeFile(artifact, JSON.stringify(manifest, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      state: "available",
      provider: result.provider,
      officialNba: false,
      startDate,
      endDate,
      events: result.records.length,
      finals: result.records.filter((g) => g.status === "final").length,
      eloEligible: elo.games.length,
      excluded: elo.excluded.length,
      snapshots: result.snapshots.length,
      artifact,
      retrospectiveForecasts: false,
      predictiveImprovementDemonstrated: false,
    },
    null,
    2,
  ),
);
