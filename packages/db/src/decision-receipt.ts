import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  decisionReceiptSchema,
  publicDecisionReceipt,
} from "../../domain/src/decision-receipt";
/** Owner-scoped allowlist: no raw prompts, learning atoms or private trace payloads. */
export async function readDecisionReceipt(
  pool: Pick<Pool, "query">,
  userId: string,
  id: string,
) {
  const row = (
    await pool.query(
      "SELECT payload,publication_state,record_id,readback_hash,recorded_at FROM decision_receipts WHERE user_id=$1 AND id=$2",
      [userId, id],
    )
  ).rows[0];
  if (!row) return null;
  const receipt = publicDecisionReceipt(row.payload);
  const outcomes = (
    await pool.query(
      `SELECT o.id,o.decision,o.recorded_at,d.payload,d.publication_state,d.record_id,d.readback_hash FROM decision_outcomes o LEFT JOIN decision_receipts d ON d.user_id=o.user_id AND d.id=o.id WHERE o.user_id=$1 AND o.root_run_id=$2 ORDER BY o.recorded_at,o.id`,
      [userId, id],
    )
  ).rows;
  return {
    receipt,
    publication: row.publication_state as
      "not_requested" | "pending" | "published" | "verified" | "failed",
    recordedAt: new Date(row.recorded_at).toISOString(),
    userDecisionReceipts: outcomes.map((o) => ({
      id: o.id,
      userDecision: o.decision,
      recordedAt: new Date(o.recorded_at).toISOString(),
      receipt: o.payload ? publicDecisionReceipt(o.payload) : null,
      publication: o.publication_state ?? "not_ready",
      proof: {
        blobId: o.record_id ?? null,
        readbackHash: o.readback_hash ?? null,
        exactRecordBinding: "unsupported" as const,
      },
    })),
    proof: {
      blobId: row.record_id as string | null,
      readbackHash: row.readback_hash as string | null,
      exactRecordBinding: "unsupported" as const,
    },
  };
}
/** Local immutable receipt and publication job commit together; remote publication/readback is asynchronous. */
export async function recordDecisionReceipt(
  pool: Pool,
  userId: string,
  input: unknown,
  options: { publicationConsent: boolean } = { publicationConsent: false },
) {
  const receipt = decisionReceiptSchema.parse(input);
  if (receipt.ownerId !== userId) throw Error("FORBIDDEN");
  if (receipt.publication !== "pending")
    throw Error("INITIAL_PUBLICATION_PENDING_REQUIRED");
  const publication = options.publicationConsent ? "pending" : "not_requested";
  const payload = JSON.stringify({ ...receipt, publication }),
    payloadHash = createHash("sha256").update(payload).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      "INSERT INTO decision_receipts(user_id,id,event_id,payload,payload_hash,publication_state) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,id) DO NOTHING RETURNING id",
      [userId, receipt.id, receipt.eventId, payload, payloadHash, publication],
    );
    if (!inserted.rowCount) {
      const old = (
        await client.query(
          "SELECT payload_hash FROM decision_receipts WHERE user_id=$1 AND id=$2",
          [userId, receipt.id],
        )
      ).rows[0];
      if (old?.payload_hash !== payloadHash)
        throw Error("RECEIPT_IDEMPOTENCY_CONFLICT");
    }
    if (options.publicationConsent)
      await client.query(
        "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'receipt_publish',$3,$4) ON CONFLICT(user_id,kind,operation_key) DO NOTHING",
        [
          randomUUID(),
          userId,
          receipt.id,
          JSON.stringify({
            receiptId: receipt.id,
            localPayloadHash: payloadHash,
            export: publicDecisionReceipt(receipt),
            publicationConsent: true,
          }),
        ],
      );
    await client.query("COMMIT");
    return { id: receipt.id, payloadHash, publication };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
