import {
  runOneClaimChallengeJob,
  createChallengeVerifier,
} from "./claim-challenge-worker";
import { runOneProsePickImpactJob } from "./pick-impact-prose-worker";
import type { Pool } from "pg";
import { runOneDecisionRecapJob } from "./decision-recap-worker";
import { runOnePickImpactJob } from "./pick-impact-worker";
import { maintainResearchArtifactMemory } from "./research-artifact-memory";
import { runOneMemoryIndexMaterialization } from "./memory-index-worker";
import { runOneLearningJob } from "./learning-worker";
import { runOneAdviceReviewJob } from "./advice-review-worker";
import { runOneEventDossierJob } from "./event-dossier-worker";
import { runOneReceiptPreparation } from "./run-receipt-worker";
import { runOneDecisionReceiptPreparation } from "./decision-receipt-worker";
import { runOneReceiptPublication } from "./receipt-publication-worker";
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
export const MAINTENANCE_PHASES = [
  "learning",
  "receipt",
  "forecast_results",
  "action_results",
  "forecast_memory",
  "action_memory",
  "pick_impact_prose",
] as const;
/** Advances before work, so failure never resets or monopolizes the durable rotation. No wall-clock scheduling. */
export async function nextMaintenancePhase(pool: Pick<Pool, "query">) {
  const row = (
    await pool.query(`INSERT INTO forecast_worker_health(job,summary,last_started_at)
 VALUES('nba.maintenance.rotation','{"next":1}'::jsonb,clock_timestamp())
 ON CONFLICT(job) DO UPDATE SET summary=jsonb_build_object('next',(COALESCE(forecast_worker_health.summary->>'next','0')::int+1)%${MAINTENANCE_PHASES.length}),last_started_at=clock_timestamp()
 RETURNING (summary->>'next')::int AS next`)
  ).rows[0];
  const index =
    (Number(row?.next) + MAINTENANCE_PHASES.length - 1) %
    MAINTENANCE_PHASES.length;
  const phase = MAINTENANCE_PHASES[index];
  if (!phase) throw Error("MAINTENANCE_ROTATION_UNAVAILABLE");
  return phase;
}
/** Local materialization plus at most one remote phase per 120s invocation. Forecast checkpoint capture is a separate leased endpoint. */
export async function runForecastMaintenance(
  pool: Pool,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return runLeasedForecastJob(pool, "nba.maintenance", async () => {
    const remotePhase = await nextMaintenancePhase(pool);
    const pickImpacts =
      env.PICK_REASON_MONITORING_ENABLED === "true"
        ? await runOnePickImpactJob(pool)
        : { checked: 0, completed: 0 };
    const decisionRecaps =
      env.PICK_REASON_MONITORING_ENABLED === "true"
        ? await runOneDecisionRecapJob(pool)
        : { checked: 0, completed: 0 };
    const pickReviewQueue =
      env.PICK_REASON_MONITORING_ENABLED === "true"
        ? (
            await pool.query(
              `SELECT count(*) FILTER(WHERE state IN ('pending','retry','processing') AND attempts<5)::int AS pending,count(*) FILTER(WHERE state='failed')::int AS failed,min(recorded_at) FILTER(WHERE state IN ('pending','retry','processing') AND attempts<5) AS oldest_pending_at FROM learning_jobs WHERE kind IN ('pick_impact','decision_recap','capture_recap')`,
            )
          ).rows[0]
        : null;
    const adviceReviews = await runOneAdviceReviewJob(pool);
    const dossiers = await runOneEventDossierJob(pool);
    const receipts = await runOneReceiptPreparation(pool);
    const decisionReceipts = await runOneDecisionReceiptPreparation(pool);
    const memoryIndex =
      env.GRAPH_RETRIEVAL_MODE === "shadow" ||
      env.GRAPH_RETRIEVAL_MODE === "verified"
        ? await runOneMemoryIndexMaterialization(pool)
        : { checked: 0, indexed: 0 };
    const writer = (owner: string) =>
      new MemwalAdapter(officialMemwalClient(parseMemwalConfig(env)), owner);
    let results = { checked: 0, verified: 0, updated: 0, unavailable: 0 };
    let actions: { checked: number; available?: boolean } = { checked: 0 };
    let learning = { checked: 0, completed: 0 },
      receiptPublication = { checked: 0, verified: 0 },
      actionMemories = { checked: 0, verified: 0 };
    let memoriesChecked = 0,
      memoriesVerified = 0;
    let artifactMemories:
      { prepared: number; checked: number; verified: number } | undefined;
    let proseImpacts = { checked: 0, completed: 0 };
    let claimChallenges = { checked: 0, completed: 0 };
    if (remotePhase === "pick_impact_prose") {
      if (env.PICK_REASON_MONITORING_ENABLED === "true")
        proseImpacts = await runOneProsePickImpactJob(pool, env);
    } else if (remotePhase === "learning") {
      let challengeTurn = false;
      if (env.THESISBREAK_ACCOUNTABILITY_ENABLED === "true") {
        const turn = (
          await pool.query(`INSERT INTO forecast_worker_health(job,summary,last_started_at)
          VALUES('nba.maintenance.accountability_learning','{"next":1}'::jsonb,clock_timestamp())
          ON CONFLICT(job) DO UPDATE SET summary=jsonb_build_object('next',(COALESCE(forecast_worker_health.summary->>'next','0')::int+1)%2),last_started_at=clock_timestamp()
          RETURNING (summary->>'next')::int AS next`)
        ).rows[0];
        challengeTurn = Number(turn?.next) === 1;
      }
      if (challengeTurn)
        claimChallenges = await runOneClaimChallengeJob(pool, {
          hosts: (env.SOURCE_WATCH_PUBLISHER_HOSTS ?? "")
            .split(",")
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean),
          verify: createChallengeVerifier(env),
        });
      else learning = await runOneLearningJob(pool, env);
    } else if (remotePhase === "receipt")
      receiptPublication = await runOneReceiptPublication(pool, writer);
    else if (remotePhase === "forecast_results")
      results = await refreshNbaForecastResults(pool, undefined, 1);
    else if (remotePhase === "action_results")
      actions = await refreshOneActionResult(pool);
    else if (remotePhase === "action_memory") {
      actionMemories = await syncOneActionMemory(pool, writer);
      if (actionMemories.checked && !actionMemories.verified)
        throw Error("ACTION_MEMORY_VERIFICATION_PENDING");
    } else {
      const pending = (
        await pool.query(
          `SELECT f.id,f.user_id FROM nba_forecasts f LEFT JOIN LATERAL(SELECT revision FROM nba_forecast_results r WHERE r.user_id=f.user_id AND r.namespace=f.namespace AND r.event_id=f.event_id ORDER BY revision DESC LIMIT 1) r ON true WHERE f.namespace='live' AND f.memory_consent=true AND NOT EXISTS(SELECT 1 FROM nba_forecast_subscriptions s WHERE s.user_id=f.user_id AND s.memory_consent=false) AND NOT EXISTS(SELECT 1 FROM nba_forecast_memory_receipts m WHERE m.forecast_id=f.id AND m.version=COALESCE(r.revision+1,1)) ORDER BY r.revision DESC NULLS LAST,f.captured_at LIMIT 1`,
        )
      ).rows;
      memoriesChecked = pending.length;
      for (const row of pending) {
        const a = writer(row.user_id);
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
      if (memoriesChecked && !memoriesVerified)
        throw Error("MEMORY_VERIFICATION_PENDING");
      // The existing forecast-memory phase has a single remote-write allowance.
      // Use it for one consented artifact only when no forecast write was attempted.
      if (!memoriesChecked && env.RESEARCH_ARTIFACT_MEMORY_ENABLED === "true")
        artifactMemories = await maintainResearchArtifactMemory(pool, {
          enabled: true,
          allowRemoteSync: true,
          createAdapter: (owner) =>
            new MemwalAdapter(
              officialMemwalClient(parseMemwalConfig(env)),
              owner,
            ),
        });
    }
    return {
      remotePhase,
      results,
      actions,
      learning,
      claimChallenges,
      adviceReviews,
      pickImpacts,
      proseImpacts,
      decisionRecaps,
      pickReviewQueue,
      dossiers,
      receipts,
      decisionReceipts,
      memoryIndex,
      receiptPublication,
      actionMemories,
      memoriesChecked,
      memoriesVerified,
      ...(artifactMemories ? { artifactMemories } : {}),
    };
  });
}
