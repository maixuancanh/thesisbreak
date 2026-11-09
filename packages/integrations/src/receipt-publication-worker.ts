import { claimLearningJob } from "../../db/src/learning-jobs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type { MemwalAdapter, MemoryRecord } from "./memwal";
import { publicDecisionReceipt } from "../../domain/src/decision-receipt";
/** Exact readback reconciliation preserves operation identity after a remote success/local crash. */
export async function runOneReceiptPublication(
  pool: Pool,
  adapterFactory: (
    owner: string,
  ) => Pick<MemwalAdapter, "remember" | "recall" | "destroy">,
  ownerId?: string,
) {
  const token = randomUUID();
  const job = await claimLearningJob(pool, {
    kinds: ["receipt_publish"],
    token,
    leaseSeconds: 150,
    ownerId,
  });
  if (!job) return { checked: 0, verified: 0 };
  let adapter: ReturnType<typeof adapterFactory> | undefined;
  try {
    const row = (
      await pool.query(
        `SELECT d.*,r.id AS root_run_id FROM decision_receipts d LEFT JOIN decision_outcomes outcome ON outcome.user_id=d.user_id AND outcome.id=d.id JOIN agent_runs r ON r.id=COALESCE(outcome.root_run_id,d.id) AND r.user_id=d.user_id JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE d.user_id=$1 AND d.id=$2 AND c.memory_consent=true`,
        [job.user_id, job.payload.receiptId],
      )
    ).rows[0];
    if (!row || job.payload.publicationConsent !== true) {
      await pool.query(
        "UPDATE learning_jobs SET state='completed',last_error='CONSENT_NOT_ACTIVE',lease_until=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",
        [job.id, token],
      );
      return { checked: 1, verified: 0 };
    }
    if (row.payload_hash !== job.payload.localPayloadHash)
      throw Error("RECEIPT_LOCAL_HASH_CHANGED");
    const record: MemoryRecord = {
      logicalId: `decision-receipt:${row.id}`,
      type: "decision.receipt",
      version: 1,
      recordedAt: new Date(row.recorded_at).toISOString(),
      payload: publicDecisionReceipt(row.payload),
    };
    adapter = adapterFactory(job.user_id);
    const prior = await adapter.recall(record.logicalId);
    const found = prior.records.find(
      (r) => r.logicalId === record.logicalId && r.version === 1,
    );
    if (prior.conflicts.includes(`${record.logicalId}@1`))
      throw Error("RECEIPT_CONFLICT");
    if (
      found &&
      (found.type !== record.type ||
        found.recordedAt !== record.recordedAt ||
        !isDeepStrictEqual(found.payload, record.payload))
    )
      throw Error("RECEIPT_CONFLICT");
    const exact = found
      ? prior.sources.find(
          (source) =>
            source.blobId &&
            source.record.logicalId === record.logicalId &&
            source.record.version === 1 &&
            source.record.hash === found.hash &&
            isDeepStrictEqual(source.record, found),
        )
      : undefined;
    const current = (
      await pool.query(
        `SELECT c.memory_consent FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id JOIN learning_jobs j ON j.id=$3 AND j.user_id=r.user_id WHERE r.user_id=$1 AND r.id=$2 AND j.state='processing' AND j.lease_token=$4 AND j.lease_until>clock_timestamp()`,
        [job.user_id, row.root_run_id, job.id, token],
      )
    ).rows[0];
    if (!current?.memory_consent) throw Error("CONSENT_OR_LEASE_CHANGED");
    const result = exact
      ? { status: "verified", blobId: exact.blobId, hash: exact.record.hash }
      : await adapter.remember(record);
    if (
      result.status !== "verified" ||
      !result.blobId ||
      !/^[a-f0-9]{64}$/.test(result.hash ?? "")
    )
      throw Error("READBACK_PENDING");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = (
        await client.query(
          "SELECT id FROM learning_jobs WHERE id=$1 AND user_id=$3 AND state='processing' AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE",
          [job.id, token, job.user_id],
        )
      ).rows[0];
      if (!locked) throw Error("LEASE_LOST");
      const consent = (
        await client.query(
          "SELECT c.memory_consent FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.user_id=$1 AND r.id=$2 FOR SHARE OF c",
          [job.user_id, row.root_run_id],
        )
      ).rows[0];
      if (!consent?.memory_consent)
        throw Error("CONSENT_CHANGED_AFTER_REMOTE_READ");
      await client.query(
        "UPDATE decision_receipts SET publication_state='verified',record_id=$3,readback_hash=$4 WHERE user_id=$1 AND id=$2",
        [job.user_id, row.id, result.blobId, result.hash],
      );
      await client.query(
        "UPDATE learning_jobs SET state='completed',lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2",
        [job.id, token],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return { checked: 1, verified: 1 };
  } catch {
    await pool.query(
      "UPDATE learning_jobs SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,retry_at=clock_timestamp()+interval '5 minutes',lease_until=NULL,last_error='RECEIPT_PUBLICATION_FAILED' WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",
      [job.id, token],
    );
    return { checked: 1, verified: 0 };
  } finally {
    adapter?.destroy();
  }
}
