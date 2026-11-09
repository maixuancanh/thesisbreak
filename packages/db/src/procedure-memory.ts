import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { getActiveProcedure } from "./procedure-versions";
import {
  buildProcedureMemoryRecord,
  procedureMemoryEnvelopeHash,
  type ProcedureReceipt,
} from "../../integrations/src/procedure-memory";
import type { MemoryRecord } from "../../integrations/src/memwal";
export interface ProcedureMemoryClaim {
  id: string;
  ownerId: string;
  reviewerId: string;
  procedureId: string;
  grantId: string;
  attempt: number;
  record: MemoryRecord;
  recordHash: string;
  receipt: ProcedureReceipt | null;
}
function rowClaim(row: Record<string, unknown>): ProcedureMemoryClaim {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    reviewerId: row.reviewer_id as string,
    procedureId: row.procedure_id as string,
    grantId: row.grant_id as string,
    attempt: row.attempts as number,
    record: row.record as MemoryRecord,
    recordHash: row.record_hash as string,
    receipt: row.receipt as ProcedureReceipt | null,
  };
}
/** Read authority every time; a successful write/old receipt never grants current authority. */
export async function assertProcedureMemoryAuthority(
  pool: Pool,
  claim: Pick<
    ProcedureMemoryClaim,
    | "ownerId"
    | "reviewerId"
    | "procedureId"
    | "grantId"
    | "record"
    | "recordHash"
  >,
): Promise<void> {
  const found = await pool.query(
    `SELECT g.procedure_hash FROM procedure_memory_grants g
 JOIN procedure_versions v ON v.id=g.procedure_id AND v.content_hash=g.procedure_hash
 JOIN procedure_active_state s ON s.active_id=v.id AND s.singleton=true
 JOIN procedure_reviewer_authorizations a ON a.user_id=$4 AND a.revoked_at IS NULL
 WHERE g.id=$1 AND g.owner_id=$2 AND g.procedure_id=$3 AND g.namespace_kind='evaluation' AND g.revoked_at IS NULL AND g.consented_at<=clock_timestamp() AND v.status='active'`,
    [claim.grantId, claim.ownerId, claim.procedureId, claim.reviewerId],
  );
  const payload = claim.record.payload;
  if (
    !found.rowCount ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.userId !== claim.ownerId ||
    payload.procedureId !== claim.procedureId ||
    payload.procedureHash !== found.rows[0].procedure_hash ||
    claim.recordHash !==
      procedureMemoryEnvelopeHash(claim.record, claim.ownerId)
  )
    throw Error("PROCEDURE_MEMORY_AUTHORITY_DENIED");
  const active = await getActiveProcedure(pool);
  if (!active || active.id !== claim.procedureId)
    throw Error("PROCEDURE_MEMORY_AUTHORITY_DENIED");
  const expected = buildProcedureMemoryRecord({
    ownerId: claim.ownerId,
    version: active,
    recordedAt: claim.record.recordedAt,
  });
  if (!isDeepStrictEqual(expected, claim.record))
    throw Error("PROCEDURE_MEMORY_RECORD_MISMATCH");
}
export async function enqueueProcedureMemory(
  pool: Pool,
  input: {
    ownerId: string;
    reviewerId: string;
    procedureId: string;
    grantId: string;
  },
): Promise<string> {
  const active = await getActiveProcedure(pool);
  if (!active || active.id !== input.procedureId)
    throw Error("PROCEDURE_NOT_ACTIVE");
  const now = (await pool.query("SELECT clock_timestamp() AS now")).rows[0]
    .now as Date;
  const record = buildProcedureMemoryRecord({
    ownerId: input.ownerId,
    version: active,
    recordedAt: now.toISOString(),
  });
  const recordHash = procedureMemoryEnvelopeHash(record, input.ownerId);
  await assertProcedureMemoryAuthority(pool, { ...input, record, recordHash });
  const result = await pool.query(
    `INSERT INTO procedure_memory_publications(id,owner_id,reviewer_id,procedure_id,grant_id,record,record_hash) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(owner_id,procedure_id,grant_id) DO UPDATE SET state=procedure_memory_publications.state RETURNING id`,
    [
      randomUUID(),
      input.ownerId,
      input.reviewerId,
      input.procedureId,
      input.grantId,
      record,
      recordHash,
    ],
  );
  return result.rows[0].id as string;
}
export async function claimProcedureMemory(
  pool: Pool,
  input: { id: string; ownerId: string; reviewerId: string },
): Promise<ProcedureMemoryClaim | null> {
  await pool.query(
    "UPDATE procedure_memory_publications SET state='blocked',lease_until=NULL,error_code='ATTEMPTS_EXHAUSTED' WHERE id=$1 AND owner_id=$2 AND reviewer_id=$3 AND attempts>=3 AND state='processing' AND lease_until<clock_timestamp()",
    [input.id, input.ownerId, input.reviewerId],
  );
  const r = await pool.query(
    `UPDATE procedure_memory_publications SET state='processing',attempts=attempts+1,lease_until=clock_timestamp()+interval '120 seconds',retry_at=NULL
 WHERE id=$1 AND owner_id=$2 AND reviewer_id=$3 AND attempts<3 AND ((state IN ('pending','retry') AND (retry_at IS NULL OR retry_at<=clock_timestamp())) OR (state='processing' AND lease_until<clock_timestamp())) RETURNING *`,
    [input.id, input.ownerId, input.reviewerId],
  );
  if (!r.rowCount) return null;
  const claim = rowClaim(r.rows[0]);
  try {
    await assertProcedureMemoryAuthority(pool, claim);
  } catch {
    await pool.query(
      "UPDATE procedure_memory_publications SET state='blocked',lease_until=NULL,error_code='AUTHORITY_DENIED' WHERE id=$1 AND attempts=$2",
      [claim.id, claim.attempt],
    );
    throw Error("PROCEDURE_MEMORY_AUTHORITY_DENIED");
  }
  return claim;
}
export async function loadProcedureMemory(
  pool: Pool,
  input: { id: string; ownerId: string; reviewerId: string },
): Promise<ProcedureMemoryClaim> {
  const r = await pool.query(
    "SELECT * FROM procedure_memory_publications WHERE id=$1 AND owner_id=$2 AND reviewer_id=$3",
    [input.id, input.ownerId, input.reviewerId],
  );
  if (!r.rowCount) throw Error("PROCEDURE_MEMORY_NOT_FOUND");
  const claim = rowClaim(r.rows[0]);
  await assertProcedureMemoryAuthority(pool, claim);
  return claim;
}
export async function finishProcedureMemory(
  pool: Pool,
  claim: ProcedureMemoryClaim,
  result: { status: string; hash?: string; blobId?: string },
): Promise<boolean> {
  let allowed = true;
  try {
    await assertProcedureMemoryAuthority(pool, claim);
  } catch {
    allowed = false;
  }
  const verified =
    allowed &&
    result.status === "verified" &&
    result.hash === claim.recordHash &&
    !!result.blobId;
  const r = await pool.query(
    `UPDATE procedure_memory_publications SET state=$4,lease_until=NULL,receipt=CASE WHEN $4='verified' THEN $5 ELSE receipt END,
 error_code=CASE WHEN $4='verified' THEN NULL ELSE 'UNVERIFIED_OR_REVOKED' END,retry_at=CASE WHEN $4='retry' THEN clock_timestamp()+interval '1 minute' ELSE NULL END
 WHERE id=$1 AND owner_id=$2 AND attempts=$3 AND state='processing' AND lease_until>clock_timestamp() AND record_hash=$6 AND reviewer_id=$7 AND procedure_id=$8 AND grant_id=$9
 AND ($4<>'verified' OR EXISTS(SELECT 1 FROM procedure_memory_grants g JOIN procedure_active_state s ON s.active_id=g.procedure_id JOIN procedure_versions v ON v.id=g.procedure_id AND v.content_hash=g.procedure_hash AND v.status='active' JOIN procedure_reviewer_authorizations a ON a.user_id=procedure_memory_publications.reviewer_id AND a.revoked_at IS NULL WHERE g.id=procedure_memory_publications.grant_id AND g.owner_id=procedure_memory_publications.owner_id AND g.revoked_at IS NULL AND g.namespace_kind='evaluation' AND g.consented_at<=clock_timestamp())) RETURNING id`,
    [
      claim.id,
      claim.ownerId,
      claim.attempt,
      verified
        ? "verified"
        : allowed && claim.attempt < 3
          ? "retry"
          : "blocked",
      verified ? { hash: result.hash, blobId: result.blobId } : null,
      claim.recordHash,
      claim.reviewerId,
      claim.procedureId,
      claim.grantId,
    ],
  );
  return !!r.rowCount && verified;
}
export async function markProcedureFreshRead(
  pool: Pool,
  claim: ProcedureMemoryClaim,
  receipt: ProcedureReceipt,
): Promise<boolean> {
  await assertProcedureMemoryAuthority(pool, claim);
  const r = await pool.query(
    `UPDATE procedure_memory_publications SET fresh_verified_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND state='verified' AND receipt=$3::jsonb AND record_hash=$4 AND EXISTS(SELECT 1 FROM procedure_memory_grants g JOIN procedure_active_state s ON s.active_id=g.procedure_id JOIN procedure_versions v ON v.id=g.procedure_id AND v.content_hash=g.procedure_hash AND v.status='active' JOIN procedure_reviewer_authorizations a ON a.user_id=procedure_memory_publications.reviewer_id AND a.revoked_at IS NULL WHERE g.id=procedure_memory_publications.grant_id AND g.owner_id=procedure_memory_publications.owner_id AND g.procedure_id=procedure_memory_publications.procedure_id AND g.namespace_kind='evaluation' AND g.consented_at<=clock_timestamp() AND g.revoked_at IS NULL) RETURNING id`,
    [claim.id, claim.ownerId, receipt, receipt.hash],
  );
  return !!r.rowCount;
}
