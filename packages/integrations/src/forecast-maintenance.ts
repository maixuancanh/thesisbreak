import type { Pool } from "pg";
import { refreshOneActionResult } from "./action-result-worker";
import { syncOneActionMemory } from "../../db/src/action-history";
import { runLeasedForecastJob } from "./forecast-tick";
import { refreshNbaForecastResults } from "./forecast-results";
import { syncNbaForecastMemory } from "../../db/src/forecast-ledger";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "./memwal";
/** Bounded production maintenance; replay and revoked memories never enter this queue. */
export async function runForecastMaintenance(
  pool: Pool,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return runLeasedForecastJob(pool, "nba.maintenance", async () => {
    const results = await refreshNbaForecastResults(pool, undefined, 2);
    const actions = await refreshOneActionResult(pool);
    const pending = (
      await pool.query(
        `SELECT f.id,f.user_id FROM nba_forecasts f LEFT JOIN LATERAL(SELECT revision FROM nba_forecast_results r WHERE r.user_id=f.user_id AND r.namespace=f.namespace AND r.event_id=f.event_id ORDER BY revision DESC LIMIT 1) r ON true WHERE f.namespace='live' AND f.memory_consent=true AND NOT EXISTS(SELECT 1 FROM nba_forecast_subscriptions s WHERE s.user_id=f.user_id AND s.memory_consent=false) AND NOT EXISTS(SELECT 1 FROM nba_forecast_memory_receipts m WHERE m.forecast_id=f.id AND m.version=COALESCE(r.revision+1,1)) ORDER BY r.revision DESC NULLS LAST,f.captured_at LIMIT 1`,
      )
    ).rows;
    let memoriesVerified = 0;
    for (const row of pending) {
      const a = new MemwalAdapter(
        officialMemwalClient(parseMemwalConfig(env)),
        row.user_id,
      );
      try {
        const result = await syncNbaForecastMemory(
          pool,
          a,
          row.user_id,
          row.id,
        );
        if (result.status === "verified") memoriesVerified++;
      } finally {
        a.destroy();
      }
    }
    if (pending.length && !memoriesVerified)
      throw Error("MEMORY_VERIFICATION_PENDING");
    const actionMemories = pending.length
      ? { checked: 0, verified: 0 }
      : await syncOneActionMemory(
          pool,
          (owner) =>
            new MemwalAdapter(
              officialMemwalClient(parseMemwalConfig(env)),
              owner,
            ),
        );
    if (actionMemories.checked && !actionMemories.verified)
      throw Error("ACTION_MEMORY_VERIFICATION_PENDING");
    return {
      results,
      actions,
      actionMemories,
      memoriesChecked: pending.length,
      memoriesVerified,
    };
  });
}
