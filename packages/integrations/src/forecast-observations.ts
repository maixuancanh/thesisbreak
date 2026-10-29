import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  fetchNbaHistory,
  parseEspnHistory,
  type NbaHistoryRecord,
} from "./news/nba-history";
export async function persistNbaObservation(
  pool: Pool,
  sourceUrl: string,
  retrievedAt: string,
  payload: unknown,
) {
  const hash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  await pool.query(
    "INSERT INTO nba_public_snapshots(id,source_url,retrieved_at,content_hash,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_url,content_hash) DO NOTHING",
    [randomUUID(), sourceUrl, retrievedAt, hash, JSON.stringify(payload)],
  );
  return hash;
}
export async function refreshNbaHistory(
  pool: Pool,
  startDate: string,
  endDate: string,
) {
  const result = await fetchNbaHistory({
    startDate,
    endDate,
    onSnapshot: async (snapshot) => {
      await persistNbaObservation(
        pool,
        snapshot.sourceUrl,
        snapshot.retrievedAt,
        JSON.parse(snapshot.body),
      );
    },
  });
  return { records: result.records.length, snapshots: result.snapshots.length };
}
export async function loadObservedHistory(pool: Pool, asOf: Date) {
  const snapshots = (
    await pool.query(
      "SELECT source_url,retrieved_at,payload FROM nba_public_snapshots WHERE source_url LIKE 'https://site.api.espn.com/%' AND retrieved_at<$1 ORDER BY retrieved_at",
      [asOf],
    )
  ).rows;
  const records = new Map<string, NbaHistoryRecord>();
  for (const row of snapshots) {
    const body = JSON.stringify(row.payload),
      hash = createHash("sha256").update(body).digest("hex");
    for (const item of parseEspnHistory(row.payload, {
      sourceUrl: row.source_url,
      retrievedAt: new Date(row.retrieved_at).toISOString(),
      sha256: hash,
    })) {
      const prior = records.get(item.eventId);
      records.set(item.eventId, {
        ...item,
        finalObservedAt:
          item.status === "final" &&
          prior?.status === "final" &&
          item.homeScore === prior.homeScore &&
          item.awayScore === prior.awayScore
            ? prior.finalObservedAt
            : item.finalObservedAt,
        resolvedAt:
          item.status === "final" &&
          prior?.status === "final" &&
          item.homeScore === prior.homeScore &&
          item.awayScore === prior.awayScore
            ? prior.resolvedAt
            : item.resolvedAt,
      });
    }
  }
  return [...records.values()];
}
