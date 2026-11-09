import "server-only";
import type { Pool } from "pg";
import type { LiveMarket } from "../live-market";
import { readPortfolioReasons } from "../../../../packages/db/src/portfolio-reasons";
import { checkSettlementRules } from "../../../../packages/domain/src/settlement-rules";
import { pickIntelligenceSchema } from "../../../../packages/domain/src/pick-intelligence";

export async function readPickIntelligence(pool: Pool, ownerId: string, market: LiveMarket, pickId?: string | null) {
  const previous = await pool.query(
    `SELECT p.id,p.current_version,s.raw->>'rules' AS rules,s.fetched_at
     FROM picks p
     JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version
     JOIN market_snapshots s ON s.id=v.snapshot_id
     WHERE p.user_id=$1 AND p.platform=$2 AND p.native_id=$3 AND ($4::text IS NULL OR p.id=$4)
     ORDER BY p.created_at DESC,p.id LIMIT 1`,
    [ownerId, market.platform, market.id, pickId ?? null],
  );
  const row = previous.rows[0];
  let connections: Awaited<ReturnType<typeof readPortfolioReasons>> | null = null;
  try { connections = await readPortfolioReasons(pool, ownerId); } catch { /* An unavailable check is visible to the agent. */ }
  return pickIntelligenceSchema.parse({
    rules: checkSettlementRules({
      rules: market.rules, sourceUrl: market.sourceUrl,
      observedAt: market.fetchedAt,
      previous: row ? { rules: row.rules, pickId: row.id, version: row.current_version, recordedAt: new Date(row.fetched_at).toISOString() } : null,
    }),
    connections: (connections?.groups ?? []).filter((group) =>
      group.mode === "live" && group.picks.some((pick) => pick.platform === market.platform && pick.nativeId === market.id),
    ).slice(0, 3),
    connectionsState: connections ? "checked" : "unavailable",
    scannedPicks: connections?.checkedPicks ?? 0,
    contextOnly: true,
  });
}
