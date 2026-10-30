import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { PublicCatalog } from "./public-catalog";
import { recordActionSettlement } from "../../db/src/action-history";
export async function refreshOneActionResult(
  pool: Pool,
  client = new PublicCatalog(),
) {
  const row = (
    await pool.query(
      `SELECT DISTINCT p.id,p.native_id,COALESCE(h.last_started_at,'epoch'::timestamptz) AS checked_at FROM picks p JOIN change_proposals a ON a.pick_id=p.id AND a.user_id=p.user_id AND a.status='accepted' LEFT JOIN forecast_worker_health h ON h.job='action.result:'||p.id WHERE p.platform='kalshi' ORDER BY checked_at LIMIT 1`,
    )
  ).rows[0];
  if (!row) return { checked: 0 };
  await pool.query(
    "INSERT INTO forecast_worker_health(job,last_started_at) VALUES($1,clock_timestamp()) ON CONFLICT(job) DO UPDATE SET last_started_at=clock_timestamp()",
    [`action.result:${row.id}`],
  );
  const page = await client.get("kalshi", row.native_id),
    m = page.data.find(
      (m) => m.id === row.native_id && m.platform === "kalshi",
    );
  if (page.provider !== "kalshi-public" || !m?.sourceUrl || !m.rules)
    return { checked: 1, available: false };
  if (m.resolution && !m.outcomes.some((o) => o.name === m.resolution?.outcome))
    throw Error("UNKNOWN_FINAL_OUTCOME");
  await recordActionSettlement(pool, row.id, {
    winner: m.resolution?.outcome ?? null,
    status: m.resolution ? "final" : "pending",
    rulesHash: createHash("sha256").update(m.rules).digest("hex"),
    sourceUrl: m.sourceUrl,
    retrievedAt: new Date().toISOString(),
  });
  return { checked: 1, available: true };
}
