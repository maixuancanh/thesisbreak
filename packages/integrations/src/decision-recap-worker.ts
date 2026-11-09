import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { claimLearningJob } from "../../db/src/learning-jobs";
import { prepareDecisionRecap } from "../../db/src/decision-recaps";
/** One local, bounded job on the existing fair leased queue. No model or remote storage call. */
export async function runOneDecisionRecapJob(pool: Pool, ownerId?: string) {
  const token = randomUUID();
  const job = await claimLearningJob(pool, {
    kinds: ["decision_recap"],
    token,
    leaseSeconds: 60,
    ownerId,
  });
  if (!job) return { checked: 0, completed: 0 };
  try {
    await prepareDecisionRecap(pool, job.user_id, job.payload.pickId, {
      jobId: job.id,
      token,
    });
    const done = await pool.query(
      "UPDATE learning_jobs SET state='completed',lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",
      [job.id, token],
    );
    return { checked: 1, completed: done.rowCount === 1 ? 1 : 0 };
  } catch {
    await pool.query(
      "UPDATE learning_jobs SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,retry_at=clock_timestamp()+interval '5 minutes',lease_until=NULL,last_error='DECISION_RECAP_FAILED' WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",
      [job.id, token],
    );
    return { checked: 1, completed: 0 };
  }
}
