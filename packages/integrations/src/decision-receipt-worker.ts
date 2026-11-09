import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { claimLearningJob } from "../../db/src/learning-jobs";
import { recordDecisionReceipt } from "../../db/src/decision-receipt";
import { decisionReceiptSchema } from "../../domain/src/decision-receipt";
/** A later user decision appends a linked receipt; the original pending receipt is never rewritten. */
export async function runOneDecisionReceiptPreparation(
  pool: Pool,
  ownerId?: string,
) {
  const token = randomUUID(),
    job = await claimLearningJob(pool, {
      kinds: ["receipt_prepare_decision"],
      token,
      leaseSeconds: 60,
      ownerId,
    });
  if (!job) return { checked: 0, completed: 0 };
  try {
    const outcome = (
      await pool.query(
        `SELECT d.*,c.memory_consent,r.user_id AS root_owner FROM decision_outcomes d JOIN agent_runs r ON r.id=d.root_run_id AND r.user_id=d.user_id JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE d.user_id=$1 AND d.id=$2`,
        [job.user_id, job.payload.decisionId],
      )
    ).rows[0];
    if (!outcome) throw Error("DECISION_SOURCE_NOT_FOUND");
    const source = (
      await pool.query(
        "SELECT * FROM decision_receipts WHERE user_id=$1 AND id=$2",
        [job.user_id, outcome.root_run_id],
      )
    ).rows[0];
    if (!source) throw Error("SOURCE_RECEIPT_PENDING");
    const original = decisionReceiptSchema.parse(source.payload);
    if (
      original.ownerId !== job.user_id ||
      original.id !== outcome.root_run_id ||
      original.sourceReceipt
    )
      throw Error("DECISION_SOURCE_MISMATCH");
    const existing = (
      await pool.query(
        "SELECT id FROM decision_receipts WHERE user_id=$1 AND id=$2",
        [job.user_id, outcome.id],
      )
    ).rows[0];
    if (!existing)
      await recordDecisionReceipt(
        pool,
        job.user_id,
        {
          ...original,
          id: outcome.id,
          sourceReceipt: { id: source.id, hash: source.payload_hash },
          proposalId: outcome.proposal_id,
          userDecision: outcome.decision,
          recordedAt: new Date(outcome.recorded_at).toISOString(),
          publication: "pending",
        },
        { publicationConsent: outcome.memory_consent === true },
      );
    const done = await pool.query(
      "UPDATE learning_jobs SET state='completed',lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",
      [job.id, token],
    );
    return { checked: 1, completed: done.rowCount === 1 ? 1 : 0 };
  } catch (error) {
    const pending =
      error instanceof Error && error.message === "SOURCE_RECEIPT_PENDING";
    await pool.query(
      "UPDATE learning_jobs SET state=CASE WHEN $3 OR attempts<5 THEN 'retry' ELSE 'failed' END,attempts=CASE WHEN $3 THEN GREATEST(0,attempts-1) ELSE attempts END,lease_until=NULL,retry_at=clock_timestamp()+interval '1 minute',last_error=$4 WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",
      [
        job.id,
        token,
        pending,
        pending ? "SOURCE_RECEIPT_PENDING" : "DECISION_RECEIPT_FAILED",
      ],
    );
    return { checked: 1, completed: 0 };
  }
}
