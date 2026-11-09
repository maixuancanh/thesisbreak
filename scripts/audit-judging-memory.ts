import { createHash } from "node:crypto";
import { config } from "dotenv";
import { Pool } from "pg";
import { recallNbaForecastMemories } from "../packages/db/src/forecast-ledger";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";

// Explicit read-only production audit. Never logs runtime configuration, owners,
// raw memory payloads or provider exception messages.
config({ path: ".local/production-runtime.env", override: true, quiet: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const verify = process.argv.includes("--verify-memory");
try {
  if (!process.env.DATABASE_URL) throw new Error("unconfigured");
  const now = (await pool.query("SELECT clock_timestamp() AS now")).rows[0]
    .now as Date;
  const current = `SELECT f.*,r.payload AS result,m.version,m.blob_id,m.hash FROM nba_forecasts f
    LEFT JOIN LATERAL (SELECT payload,revision FROM nba_forecast_results WHERE user_id=f.user_id AND namespace=f.namespace AND event_id=f.event_id AND recorded_at<$1 ORDER BY revision DESC LIMIT 1) r ON true
    JOIN nba_forecast_memory_receipts m ON m.forecast_id=f.id AND m.version=COALESCE(r.revision+1,1)
    WHERE f.namespace='live' AND f.memory_consent=true AND f.captured_at<$1
    AND NOT EXISTS(SELECT 1 FROM nba_forecast_subscriptions s WHERE s.user_id=f.user_id AND s.memory_consent=false)`;
  const summary = (
    await pool.query(
      `WITH current AS (${current}) SELECT count(*)::int AS current_receipts,count(DISTINCT blob_id)::int AS distinct_blobs,count(DISTINCT hash)::int AS distinct_hashes,count(DISTINCT (id,version))::int AS distinct_forecast_versions,count(*) FILTER(WHERE result->>'status'='final')::int AS current_final_receipts FROM current`,
      [now],
    )
  ).rows[0];
  const selected = (
    await pool.query(
      `WITH current AS (${current}) SELECT * FROM current ORDER BY (result->>'status'='final') DESC NULLS LAST,captured_at DESC,id LIMIT 10`,
      [now],
    )
  ).rows;
  const entries = [];
  for (const row of selected) {
    let readback:
      "not_requested" | "verified" | "not_found_or_rejected" | "unavailable" =
      "not_requested";
    if (verify) {
      const adapter = new MemwalAdapter(
        officialMemwalClient(parseMemwalConfig(process.env)),
        row.user_id,
      );
      try {
        const recalled = await recallNbaForecastMemories(
          pool,
          row.user_id,
          (query) => adapter.recall(query),
          now,
          { forecastIds: [row.id] },
        );
        readback = recalled.length === 1 ? "verified" : "not_found_or_rejected";
      } catch {
        readback = "unavailable";
      } finally {
        adapter.destroy();
      }
    }
    const final = row.result?.status === "final";
    entries.push({
      artifactRef: createHash("sha256")
        .update(row.id)
        .digest("hex")
        .slice(0, 16),
      type: "nba.forecast",
      version: Number(row.version),
      blobId: row.blob_id,
      hash: row.hash,
      resultStatus: row.result?.status ?? "awaiting_result",
      horizon: row.horizon,
      capturedAt: new Date(row.captured_at).toISOString(),
      readback,
      utility: final
        ? "Compare an immutable pre-event forecast and baseline with the official result; audit calibration and earlier reasoning."
        : "Preserve a timestamped pre-event forecast and paired baseline for later scoring.",
      review: "candidate_unreviewed",
      userLessonApproval: "not_asserted",
    });
  }
  console.log(
    JSON.stringify(
      {
        check: "judging.current_memory_inventory",
        checkedAt: new Date(now).toISOString(),
        readOnly: true,
        selection:
          "At most ten current consented receipt-backed forecast artifacts, finals first; exact targeted readback keeps all production authority checks.",
        summary,
        selected: entries.length,
        freshReadbackVerified: entries.filter((e) => e.readback === "verified")
          .length,
        freshFinalReadbackVerified: entries.filter(
          (e) => e.readback === "verified" && e.resultStatus === "final",
        ).length,
        distinctSelectedBlobs: new Set(entries.map((e) => e.blobId)).size,
        distinctSelectedHashes: new Set(entries.map((e) => e.hash)).size,
        usefulHumanReviewed: 0,
        usefulCandidatesUnreviewed: entries.length,
        agentUseDemonstrated: false,
        predictiveImprovementDemonstrated: false,
        entries,
      },
      null,
      2,
    ),
  );
} catch {
  console.error("JUDGING_MEMORY_AUDIT_UNAVAILABLE");
  process.exitCode = 1;
} finally {
  await pool.end();
}
