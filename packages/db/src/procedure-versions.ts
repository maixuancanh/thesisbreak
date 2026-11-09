import type { Pool, PoolClient } from "pg";
import {
  createProcedureVersion,
  evaluateProcedure,
  reviewProcedure,
  procedureContentHash,
  type ProcedureVersion,
  type ProcedureStatus,
} from "../../domain/src/procedure-version";
type Connection = Pool | PoolClient;
function decode(row: Record<string, unknown>): ProcedureVersion {
  const draft = createProcedureVersion({
    id: row.id as string,
    parentId: row.parent_id as string | null,
    parentHash: row.parent_hash as string | null,
    content: row.content,
    corpusVersion: row.corpus_version as string,
    failureExampleIds: row.failure_example_ids as string[],
  });
  if (draft.hash !== row.content_hash) throw Error("PROCEDURE_HASH_MISMATCH");
  const evaluated = row.evaluation
    ? evaluateProcedure(draft, row.evaluation)
    : draft;
  return Object.freeze({
    ...evaluated,
    status: row.status as ProcedureStatus,
    reviewerId: row.reviewer_id as string | null,
    reviewedAt: row.reviewed_at
      ? new Date(row.reviewed_at as string).toISOString()
      : null,
  });
}
async function authorized(c: Connection, reviewerId: string) {
  const r = await c.query(
    "SELECT user_id FROM procedure_reviewer_authorizations WHERE user_id=$1 AND revoked_at IS NULL FOR SHARE",
    [reviewerId],
  );
  if (!r.rowCount) throw Error("PROCEDURE_REVIEWER_NOT_AUTHORIZED");
}
async function transaction<T>(
  pool: Pool,
  reviewerId: string,
  work: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await authorized(c, reviewerId);
    const result = await work(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
async function lockedVersion(c: PoolClient, id: string) {
  const r = await c.query(
    "SELECT * FROM procedure_versions WHERE id=$1 FOR UPDATE",
    [id],
  );
  if (!r.rowCount) throw Error("PROCEDURE_NOT_FOUND");
  return decode(r.rows[0]);
}
export async function saveProcedureDraft(
  pool: Pool,
  reviewerId: string,
  input: ProcedureVersion,
): Promise<void> {
  const version = createProcedureVersion({
    id: input.id,
    parentId: input.parentId,
    parentHash: input.parentHash,
    content: input.content,
    corpusVersion: input.corpusVersion,
    failureExampleIds: [...input.failureExampleIds],
  });
  if (
    input.status !== "draft" ||
    input.hash !== procedureContentHash(input.content)
  )
    throw Error("PROCEDURE_DRAFT_REQUIRED");
  await transaction(pool, reviewerId, async (c) => {
    if (version.parentId) {
      const p = await lockedVersion(c, version.parentId);
      if (p.hash !== version.parentHash)
        throw Error("PROCEDURE_PARENT_HASH_MISMATCH");
    }
    await c.query(
      "INSERT INTO procedure_versions(id,parent_id,parent_hash,content_hash,content,corpus_version,failure_example_ids) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        version.id,
        version.parentId,
        version.parentHash,
        version.hash,
        version.content,
        version.corpusVersion,
        JSON.stringify(version.failureExampleIds),
      ],
    );
  });
}
export async function sealProcedureEvaluation(
  pool: Pool,
  reviewerId: string,
  id: string,
  report: unknown,
): Promise<void> {
  await transaction(pool, reviewerId, async (c) => {
    const version = evaluateProcedure(await lockedVersion(c, id), report);
    await c.query(
      "UPDATE procedure_versions SET evaluation=$2,status=$3 WHERE id=$1",
      [id, version.evaluation, version.status],
    );
    await c.query(
      "INSERT INTO procedure_reviews(version_id,reviewer_id,action,reason) VALUES($1,$2,'evaluate',$3)",
      [id, reviewerId, version.evaluation!.reportHash],
    );
  });
}
export async function reviewProcedureCandidate(
  pool: Pool,
  reviewerId: string,
  id: string,
  approve: boolean,
): Promise<void> {
  await transaction(pool, reviewerId, async (c) => {
    const now = (await c.query("SELECT clock_timestamp() AS now")).rows[0]
      .now as Date;
    const version = reviewProcedure(await lockedVersion(c, id), {
      reviewerId,
      at: now.toISOString(),
      approve,
    });
    await c.query(
      "UPDATE procedure_versions SET status=$2,reviewer_id=$3,reviewed_at=$4 WHERE id=$1",
      [id, version.status, reviewerId, now],
    );
    await c.query(
      "INSERT INTO procedure_reviews(version_id,reviewer_id,action,reason) VALUES($1,$2,$3,$4)",
      [
        id,
        reviewerId,
        approve ? "approve" : "reject",
        "Explicit reviewer decision",
      ],
    );
  });
}
/** Operator-only: reviewer authority comes from the database, never an ordinary user role claim. */
export async function promoteProcedure(
  pool: Pool,
  input: {
    reviewerId: string;
    versionId: string;
    expectedActiveId: string | null;
    reason: string;
    rollback?: boolean;
  },
): Promise<void> {
  if (!input.reason.trim()) throw Error("PROCEDURE_REASON_REQUIRED");
  await transaction(pool, input.reviewerId, async (c) => {
    const state = (
      await c.query(
        "SELECT active_id FROM procedure_active_state WHERE singleton=true FOR UPDATE",
      )
    ).rows[0];
    if (!state || state.active_id !== input.expectedActiveId)
      throw Error("PROCEDURE_STALE_ACTIVE_VERSION");
    const version = await lockedVersion(c, input.versionId);
    if (
      input.rollback
        ? version.status !== "retired"
        : version.status !== "approved"
    )
      throw Error("PROCEDURE_REVIEW_REQUIRED");
    if (
      !version.reviewerId ||
      !version.reviewedAt ||
      !version.evaluation ||
      version.evaluation.criticalViolations.length ||
      !version.evaluation.validationPassed ||
      !version.evaluation.sealedTestPassed
    )
      throw Error("PROCEDURE_REVIEW_REQUIRED");
    if (!input.rollback && version.parentId !== input.expectedActiveId)
      throw Error("PROCEDURE_PARENT_NOT_ACTIVE");
    if (state.active_id)
      await c.query(
        "UPDATE procedure_versions SET status='retired' WHERE id=$1",
        [state.active_id],
      );
    await c.query("UPDATE procedure_versions SET status='active' WHERE id=$1", [
      version.id,
    ]);
    await c.query(
      "UPDATE procedure_active_state SET active_id=$1,revision=revision+1 WHERE singleton=true",
      [version.id],
    );
    await c.query(
      "INSERT INTO procedure_reviews(version_id,reviewer_id,action,previous_active_id,reason) VALUES($1,$2,$3,$4,$5)",
      [
        version.id,
        input.reviewerId,
        input.rollback ? "rollback" : "activate",
        state.active_id,
        input.reason,
      ],
    );
  });
}
/** Snapshot bound once at run start; subsequent promotions cannot mutate this object. */
export async function getActiveProcedure(
  pool: Pool,
): Promise<ProcedureVersion | null> {
  const r = await pool.query(
    "SELECT v.* FROM procedure_active_state s JOIN procedure_versions v ON v.id=s.active_id WHERE s.singleton=true AND v.status='active'",
  );
  if (!r.rowCount) return null;
  const v = decode(r.rows[0]);
  if (
    !v.reviewerId ||
    !v.reviewedAt ||
    !v.evaluation ||
    v.evaluation.criticalViolations.length ||
    !v.evaluation.validationPassed ||
    !v.evaluation.sealedTestPassed
  )
    throw Error("PROCEDURE_ACTIVE_NOT_REVIEWED");
  return v;
}
