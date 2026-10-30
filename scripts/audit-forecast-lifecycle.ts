import "dotenv/config";
import { Pool } from "pg";
import { recallNbaForecastMemories } from "../packages/db/src/forecast-ledger";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";

/** Read-only live acceptance audit. Empty queues are pending evidence, never a passing lifecycle. */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const counts = (
    await pool.query(`
    WITH live AS (SELECT * FROM nba_forecasts WHERE namespace='live'),
    latest AS (
      SELECT f.*,r.payload AS result,r.revision,
        EXISTS(SELECT 1 FROM nba_forecast_memory_receipts m WHERE m.forecast_id=f.id AND m.version=1) AS initial_memory,
        EXISTS(SELECT 1 FROM nba_forecast_memory_receipts m WHERE m.forecast_id=f.id AND m.version=r.revision+1) AS result_memory
      FROM live f LEFT JOIN LATERAL (
        SELECT payload,revision FROM nba_forecast_results r WHERE r.user_id=f.user_id AND r.namespace=f.namespace AND r.event_id=f.event_id ORDER BY revision DESC LIMIT 1
      ) r ON true
    )
    SELECT clock_timestamp() AS checked_at,
      count(*)::int AS forecasts, count(DISTINCT event_id)::int AS distinct_events,
      count(*) FILTER(WHERE payload->>'probability' IS NOT NULL)::int AS probabilities,
      count(*) FILTER(WHERE payload->>'baselineProbability' IS NOT NULL)::int AS paired_baselines,
      count(*) FILTER(WHERE result->>'status'='final')::int AS finalized_forecasts,
      count(DISTINCT event_id) FILTER(WHERE result->>'status'='final')::int AS finalized_events,
      count(*) FILTER(WHERE initial_memory)::int AS initial_memory_receipts,
      count(*) FILTER(WHERE result->>'status'='final' AND result_memory)::int AS result_memory_receipts,
      count(*) FILTER(WHERE captured_at>=scheduled_at OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(payload->'evidence') e WHERE (e->>'retrievedAt')::timestamptz>captured_at OR (e->>'publishedAt')::timestamptz>captured_at
      ))::int AS temporal_violations
    FROM latest
  `)
  ).rows[0];
  const verify = process.argv.includes("--verify-memory");
  const clockHealth = (
    await pool.query(
      "SELECT job,last_started_at,last_success_at,last_failed_at,lease_until,summary FROM forecast_worker_health ORDER BY job",
    )
  ).rows;
  const cloudClock = clockHealth.find(
    (r) => r.job === "nba.capture.cloudflare",
  );
  const clockStale =
    !!cloudClock &&
    Date.now() - new Date(cloudClock.last_started_at).getTime() > 300000;
  let recalled = 0,
    recalledFinal = 0,
    checkedOwners = 0;
  if (verify) {
    const owners = (
      await pool.query(
        `SELECT DISTINCT f.user_id FROM nba_forecasts f JOIN nba_forecast_memory_receipts m ON m.forecast_id=f.id WHERE f.namespace='live' AND f.memory_consent=true AND NOT EXISTS(SELECT 1 FROM nba_forecast_subscriptions s WHERE s.user_id=f.user_id AND s.memory_consent=false) ORDER BY f.user_id LIMIT 5`,
      )
    ).rows;
    for (const owner of owners) {
      const adapter = new MemwalAdapter(
        officialMemwalClient(parseMemwalConfig(process.env)),
        owner.user_id,
      );
      try {
        const rows = await recallNbaForecastMemories(
          pool,
          owner.user_id,
          (query) => adapter.recall(query),
        );
        recalled += rows.length;
        recalledFinal += rows.filter(
          (r) =>
            (r as { result?: { status?: string } }).result?.status === "final",
        ).length;
        checkedOwners++;
      } finally {
        adapter.destroy();
      }
    }
  }
  const reasons: string[] = [];
  if (!counts.forecasts) reasons.push("awaiting_genuine_future_checkpoint");
  if (!counts.finalized_events) reasons.push("awaiting_official_final_result");
  if (!counts.result_memory_receipts)
    reasons.push("awaiting_verified_result_memory");
  if (!verify || !recalledFinal)
    reasons.push("final_result_fresh_recall_not_demonstrated");
  if (counts.temporal_violations) reasons.push("temporal_integrity_failure");
  if (clockStale) reasons.push("capture_clock_heartbeat_stale");
  console.log(
    JSON.stringify({
      check: "nba.live_lifecycle",
      counts,
      clockHealth,
      freshWalrusReadback: {
        requested: verify,
        checkedOwners,
        recalled,
        recalledFinal,
        limit: "5 owners, 4 current versions each",
      },
      status:
        counts.temporal_violations || clockStale
          ? "failed"
          : reasons.length
            ? "pending_evidence"
            : "storage_lifecycle_verified",
      reasons,
      agentUseDemonstrated: false,
      multiEventImprovementDemonstrated: false,
      predictiveAccuracyImprovementDemonstrated: false,
    }),
  );
  if (counts.temporal_violations || clockStale) process.exitCode = 1;
} finally {
  await pool.end();
}
