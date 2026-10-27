import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { lessonVersionSchema } from "../../domain/src/lesson";
import type { MemoryRecord } from "../../integrations/src/memwal";
import type { MemorySyncResult } from "../../integrations/src/memory-sync";
import { validateSourceScore } from "../../domain/src/source-credibility";
export interface LessonRow {
  lesson_id: string;
  user_id: string;
  version: number;
  parent_version: number | null;
  rule: string;
  scope: unknown;
  approval: string;
  status: string;
  effective_at: Date;
  expires_at: Date | null;
  review_at: Date | null;
  superseded_by: string | null;
  originating_correction: string | null;
}
export function lessonRowToPayload(row: LessonRow) {
  return lessonVersionSchema.parse({
    id: row.lesson_id,
    userId: row.user_id,
    version: row.version,
    parentVersion: row.parent_version,
    rule: row.rule,
    scope: row.scope,
    approval: row.approval,
    status: row.status,
    effectiveAt: row.effective_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    supersededBy: row.superseded_by,
    ...(row.review_at ? { reviewAt: row.review_at.toISOString() } : {}),
    ...(row.originating_correction !== null
      ? { originatingCorrection: row.originating_correction }
      : {}),
  });
}
export interface MemoryClaim {
  operationKey: string;
  userId: string;
  attempt: number;
  record: MemoryRecord;
}
/** Attempts is a monotonic fencing token. Unsupported and unconsented events remain untouched. */
async function claimOneMemoryOutbox(
  pool: Pool,
  leaseMs = 120000,
  ownerId?: string,
): Promise<MemoryClaim | null | "skipped"> {
  if (!Number.isFinite(leaseMs) || leaseMs < 1000)
    throw new Error("INVALID_LEASE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{
      operation_key: string;
      user_id: string;
      attempts: number;
      kind: string;
      payload: { lessonId: string; sourceProfileId?: string; version: number };
      created_at: Date;
    }>(
      `SELECT * FROM outbox WHERE ($1::text IS NULL OR user_id=$1) AND kind IN ('lesson.version.created','source.score.created') AND payload->'memoryConsent'='true'::jsonb AND ((state IN ('pending','retry') AND (retry_at IS NULL OR retry_at<=now())) OR (state='processing' AND lease_until<=now())) ORDER BY created_at,operation_key FOR UPDATE SKIP LOCKED LIMIT 1`,
      [ownerId ?? null],
    );
    const event = found.rows[0];
    if (!event) {
      await client.query("COMMIT");
      return null;
    }
    const logicalId =
      event.kind === "source.score.created"
        ? event.payload.sourceProfileId
        : event.payload.lessonId;
    if (
      typeof logicalId !== "string" ||
      !logicalId.trim() ||
      !Number.isSafeInteger(event.payload.version) ||
      event.payload.version < 1
    ) {
      await client.query(
        `UPDATE outbox SET state='blocked',lease_until=NULL,outcome=$2 WHERE operation_key=$1`,
        [
          event.operation_key,
          JSON.stringify({ reason: "invalid_memory_event" }),
        ],
      );
      await client.query("COMMIT");
      return "skipped";
    }
    let record: MemoryRecord;
    if (event.kind === "source.score.created") {
      const row = (
        await client.query(
          "SELECT v.payload FROM source_score_versions v JOIN source_profiles p ON p.id=v.profile_id AND p.user_id=v.user_id WHERE v.profile_id=$1 AND v.user_id=$2 AND v.version=$3 AND p.current_version=v.version AND p.state='active' AND p.memory_consent=true",
          [logicalId, event.user_id, event.payload.version],
        )
      ).rows[0];
      if (!row) {
        await client.query(
          "UPDATE outbox SET state='blocked',lease_until=NULL,outcome=$2 WHERE operation_key=$1",
          [
            event.operation_key,
            JSON.stringify({ reason: "source_not_current_active_consented" }),
          ],
        );
        await client.query("COMMIT");
        return "skipped";
      }
      const payload = validateSourceScore(row.payload);
      if (
        payload.userId !== event.user_id ||
        payload.id !== logicalId ||
        payload.version !== event.payload.version
      )
        throw new Error("SOURCE_OWNER_MISMATCH");
      record = {
        logicalId,
        type: "source_credibility",
        version: payload.version,
        recordedAt: event.created_at.toISOString(),
        payload: JSON.parse(JSON.stringify(payload)) as MemoryRecord["payload"],
      };
    } else {
      const version = await client.query<LessonRow>(
        `SELECT v.* FROM lesson_versions v JOIN lessons l ON l.id=v.lesson_id AND l.user_id=v.user_id WHERE v.lesson_id=$1 AND v.user_id=$2 AND v.version=$3 AND l.current_version=v.version AND v.approval='approved' AND v.status='active' AND v.superseded_by IS NULL`,
        [event.payload.lessonId, event.user_id, event.payload.version],
      );
      if (!version.rows[0]) {
        await client.query(
          `UPDATE outbox SET state='blocked',outcome=$2 WHERE operation_key=$1`,
          [
            event.operation_key,
            JSON.stringify({ reason: "lesson_not_current_approved_active" }),
          ],
        );
        await client.query("COMMIT");
        return "skipped";
      }
      const payload = lessonRowToPayload(version.rows[0]);
      record = {
        logicalId,
        type: "lesson",
        version: payload.version,
        recordedAt: event.created_at.toISOString(),
        payload: JSON.parse(JSON.stringify(payload)) as MemoryRecord["payload"],
      };
    }
    // Persist the immutable record itself in outcome so a crash/reclaim never changes its timestamp or bytes.
    const held = await client.query<{
      outcome: { record?: MemoryRecord } | null;
    }>("SELECT outcome FROM outbox WHERE operation_key=$1", [
      event.operation_key,
    ]);
    const previous = held.rows[0]?.outcome?.record;
    if (previous && !isDeepStrictEqual(previous, record))
      throw new Error("IMMUTABLE_MEMORY_CONFLICT");
    await client.query(
      `UPDATE outbox SET state='processing',attempts=attempts+1,lease_until=now()+($2 * interval '1 millisecond'),retry_at=NULL,outcome=$3 WHERE operation_key=$1`,
      [event.operation_key, leaseMs, JSON.stringify({ record })],
    );
    await client.query(
      `INSERT INTO memory_records(logical_id,user_id,schema_version,type,payload_hash,sync_status,recorded_at) VALUES($1,$2,1,$5,$3,'pending',$4) ON CONFLICT(logical_id) DO NOTHING`,
      [
        event.operation_key,
        event.user_id,
        createHash("sha256")
          .update(JSON.stringify(record.payload))
          .digest("hex"),
        event.created_at,
        record.type,
      ],
    );
    await client.query("COMMIT");
    return {
      operationKey: event.operation_key,
      userId: event.user_id,
      attempt: event.attempts + 1,
      record,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
/** Bounded draining prevents stale events from masquerading as an empty queue. */
export async function claimMemoryOutbox(
  pool: Pool,
  leaseMs = 120000,
  ownerId?: string,
): Promise<MemoryClaim | null> {
  for (let skipped = 0; skipped < 100; skipped++) {
    const result = await claimOneMemoryOutbox(pool, leaseMs, ownerId);
    if (result !== "skipped") return result;
  }
  throw new Error("MEMORY_OUTBOX_SKIP_BUDGET_EXCEEDED");
}
export async function finishMemoryOutbox(
  pool: Pool,
  claim: MemoryClaim,
  result: MemorySyncResult,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (claim.record.type === "source_credibility") {
      const p = (
        await client.query(
          "SELECT state,current_version,memory_consent FROM source_profiles WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [claim.record.logicalId, claim.userId],
        )
      ).rows[0];
      if (
        !p ||
        p.state !== "active" ||
        p.memory_consent !== true ||
        p.current_version !== claim.record.version
      ) {
        await client.query(
          "UPDATE outbox SET state='blocked',lease_until=NULL WHERE operation_key=$1 AND user_id=$2 AND attempts=$3",
          [claim.operationKey, claim.userId, claim.attempt],
        );
        await client.query("COMMIT");
        return false;
      }
    }
    const fence = await client.query(
      `SELECT operation_key FROM outbox WHERE operation_key=$1 AND user_id=$2 AND state='processing' AND attempts=$3 AND lease_until>now() FOR UPDATE`,
      [claim.operationKey, claim.userId, claim.attempt],
    );
    if (!fence.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    const verified = result.status === "verified";
    if (verified)
      await client.query(
        `UPDATE memory_records SET sync_status='verified',durable_reference=$3,receipt=$4 WHERE logical_id=$1 AND user_id=$2`,
        [
          claim.operationKey,
          claim.userId,
          result.blobId,
          JSON.stringify(result),
        ],
      );
    await client.query(
      `UPDATE outbox SET state=$4,lease_until=NULL,retry_at=CASE WHEN $4='retry' THEN now()+($5 * interval '1 millisecond') ELSE NULL END,outcome=$6 WHERE operation_key=$1 AND user_id=$2 AND attempts=$3`,
      [
        claim.operationKey,
        claim.userId,
        claim.attempt,
        verified ? "done" : "retry",
        Math.min(3600000, 1000 * 2 ** Math.min(claim.attempt, 12)),
        JSON.stringify({ record: claim.record, result }),
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
