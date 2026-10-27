import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { PublicCatalog } from "./public-catalog";
import { settleSourceForecasts } from "../../db/src/source-credibility";
/** Shared database claim: no per-user provider loop or client-supplied results. */
export async function refreshOneSourceMarket(
  pool: Pool,
  client = new PublicCatalog(),
) {
  const c = await pool.connect();
  let market:
    { platform: "kalshi" | "polymarket"; native_id: string } | undefined;
  try {
    await c.query("BEGIN");
    market = (
      await c.query(
        "SELECT f.platform,f.native_id FROM source_forecasts f JOIN source_profiles p ON p.id=f.profile_id AND p.user_id=f.user_id WHERE p.state='active' AND f.platform='kalshi' AND f.next_check_at<=now() ORDER BY f.next_check_at,f.id FOR UPDATE OF f SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (market)
      await c.query(
        "UPDATE source_forecasts SET next_check_at=now()+CASE WHEN resolution IS NOT NULL AND (resolution->>'resolvedAt')::timestamptz<now()-interval '7 days' THEN interval '1 day' ELSE interval '5 minutes' END WHERE platform=$1 AND native_id=$2",
        [market.platform, market.native_id],
      );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  if (!market) return { checked: false, updated: 0 };
  const page = await client.get(market.platform, market.native_id);
  const row = page.data.find(
    (r) => r.platform === market!.platform && r.id === market!.native_id,
  );
  if (page.provider !== "kalshi-public" || !row?.rules || !row.sourceUrl)
    return { checked: true, updated: 0 };
  const updated = await settleSourceForecasts(pool, {
    platform: market.platform,
    nativeId: market.native_id,
    rulesHash: createHash("sha256").update(row.rules).digest("hex"),
    reference: row.sourceUrl,
    resolution: row.resolution ?? null,
  });
  return { checked: true, updated };
}
