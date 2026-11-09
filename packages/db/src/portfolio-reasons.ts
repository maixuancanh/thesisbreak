import type { Pool } from "pg";
import { groupPortfolioReasons, type PortfolioPick } from "../../domain/src/portfolio-reasons";
import { monitoringTransaction } from "./pick-reasons";

export async function readPortfolioReasons(pool: Pool, ownerId: string) {
  return monitoringTransaction(pool, ownerId, async (client) => {
    const { rows } = await client.query(
      `SELECT p.id,p.platform,p.native_id,p.current_version,v.outcome,v.reason,
        s.question,r.payload,clock_timestamp() AS checked_at
       FROM picks p
       JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version
       LEFT JOIN market_snapshots s ON s.id=v.snapshot_id
       LEFT JOIN LATERAL (
         SELECT payload FROM pick_reason_versions r
         WHERE r.user_id=p.user_id AND r.pick_id=p.id AND r.pick_version=p.current_version AND r.confirmed_at<=clock_timestamp()
         ORDER BY revision DESC LIMIT 1
       ) r ON true
       WHERE p.user_id=$1 AND p.state IN ('active','following') AND (s.close_time IS NULL OR s.close_time>clock_timestamp())
       ORDER BY p.created_at DESC,p.id LIMIT 100`,
      [ownerId],
    );
    // Keep live, acceptance and replay groups separate even when their text matches.
    const modes = new Map<string, PortfolioPick[]>();
    for (const row of rows) {
      const payload = row.payload;
      if (payload && (payload.ownerId !== ownerId || payload.pickId !== row.id || payload.pickVersion !== row.current_version)) continue;
      const mode = payload?.mode ?? (/acceptance test/i.test(row.reason) ? "acceptance_test" : "live");
      const picks = modes.get(mode) ?? [];
      picks.push({
        id: row.id, version: row.current_version,
        platform: row.platform, nativeId: row.native_id,
        question: row.question ?? row.native_id, outcome: row.outcome,
        reason: payload?.userText ?? row.reason,
        conditions: payload?.conditions ?? [],
      });
      modes.set(mode, picks);
    }
    const now = rows[0]?.checked_at ? new Date(rows[0].checked_at) : new Date();
    return {
      groups: [...modes.entries()].flatMap(([mode, picks]) =>
        groupPortfolioReasons(picks, now).map((group) => ({ ...group, mode })),
      ),
      checkedPicks: rows.length,
      limit: 100,
      checkedAt: now.toISOString(),
    };
  });
}
