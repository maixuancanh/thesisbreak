import { claimLearningJob } from "../../db/src/learning-jobs";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { dependencySchema } from "../../agent/src/event-dossier";
const explanations = {
  current:
    "Supporting evidence has a newer version. Review this advice before confirming a change.",
  false:
    "Supporting evidence was corrected as false. The original advice is preserved and needs review.",
  superseded:
    "Supporting evidence was superseded. Review the replacement before using this advice.",
  revoked:
    "A supporting rule or source was revoked. This advice needs review before confirmation.",
  unavailable:
    "Supporting evidence is currently unavailable. This does not establish that the original fact was false.",
  broken:
    "The supporting reference could not be resolved. This advice remains preserved and needs review.",
  pending_consolidation:
    "Supporting evidence is being consolidated. Wait for a reviewed version before confirming.",
};
/** Bounded deterministic targeted reassessment; preserves advice and never mutates a pick. */
export async function runOneAdviceReviewJob(pool: Pool) {
  const token = randomUUID();
  const job = await claimLearningJob(pool, {
    kinds: ["advice_review"],
    token,
    leaseSeconds: 30,
  });
  if (!job) return { checked: 0, completed: 0 };
  const client = await pool.connect();
  try {
    const d = dependencySchema.parse({
      id: job.payload.dependencyId,
      version: job.payload.version,
      hash: job.payload.hash,
      status: job.payload.status,
    });
    await client.query("BEGIN");
    const active = (
      await client.query(
        "SELECT id FROM learning_jobs WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE",
        [job.id, token],
      )
    ).rows[0];
    if (!active) throw Error("LEASE_LOST");
    const ref = (
      await client.query(
        "SELECT monitoring,consent FROM decision_dependencies WHERE user_id=$1 AND decision_id=$2 AND dependency_id=$3 FOR UPDATE",
        [job.user_id, job.payload.decisionId, d.id],
      )
    ).rows[0];
    const enabled = ref?.monitoring === true && ref?.consent === true;
    await client.query(
      "INSERT INTO decision_advice_reviews(user_id,operation_key,decision_id,event_id,dependency_id,dependency_status,explanation,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,operation_key) DO NOTHING",
      [
        job.user_id,
        job.operation_key,
        job.payload.decisionId,
        job.payload.eventId,
        d.id,
        d.status,
        enabled
          ? explanations[d.status]
          : "Monitoring or consent was disabled; no reassessment was applied.",
        enabled ? "review_required" : "monitoring_disabled",
      ],
    );
    await client.query(
      "UPDATE learning_jobs SET state='completed',lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2",
      [job.id, token],
    );
    await client.query("COMMIT");
    return { checked: 1, completed: 1 };
  } catch {
    await client.query("ROLLBACK");
    await pool.query(
      "UPDATE learning_jobs SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,retry_at=clock_timestamp()+interval '5 minutes',lease_until=NULL,last_error='ADVICE_REVIEW_FAILED' WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",
      [job.id, token],
    );
    return { checked: 1, completed: 0 };
  } finally {
    client.release();
  }
}
export async function listAdviceReviews(
  pool: Pick<Pool, "query">,
  userId: string,
  decisionId?: string,
) {
  return (
    await pool.query(
      "SELECT decision_id,event_id,dependency_id,dependency_status,explanation,state,recorded_at FROM decision_advice_reviews WHERE user_id=$1 AND ($2::text IS NULL OR decision_id=$2) ORDER BY recorded_at DESC LIMIT 50",
      [userId, decisionId ?? null],
    )
  ).rows;
}
