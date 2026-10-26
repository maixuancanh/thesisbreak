import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  lessonCreateSchema,
  lessonUpdateSchema,
} from "../../domain/src/lesson-review";
import { DomainConflict } from "../../domain/src/index";
import { commitLessonVersion } from "./versioning";
import { lessonRowToPayload } from "./memory-outbox";

export async function createApprovedLesson(
  pool: Pool,
  userId: string,
  value: unknown,
) {
  const input = lessonCreateSchema.parse(value);
  const hash = createHash("sha256")
    .update(JSON.stringify({ kind: "lesson.create", ...input }))
    .digest("hex");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([userId, input.requestId]),
    ]);
    const old = (
      await c.query(
        "SELECT request_hash,result FROM mutation_requests WHERE user_id=$1 AND request_id=$2",
        [userId, input.requestId],
      )
    ).rows[0];
    if (old) {
      if (old.request_hash !== hash)
        throw new DomainConflict("IDEMPOTENCY_KEY_REUSED");
      await c.query("COMMIT");
      return old.result as { lessonId: string; version: number };
    }
    if (input.sourceRunId) {
      const source = await c.query(
        "SELECT id FROM agent_runs WHERE id=$1 AND user_id=$2 AND status='completed'",
        [input.sourceRunId, userId],
      );
      if (!source.rows.length) throw new Error("NOT_FOUND");
    }
    const count = await c.query(
      "SELECT COUNT(*)::int AS count FROM lessons WHERE user_id=$1",
      [userId],
    );
    if (count.rows[0].count >= 500)
      throw new DomainConflict("LESSON_LIMIT_REACHED");
    const id = randomUUID();
    await c.query("INSERT INTO lessons(id,user_id) VALUES($1,$2)", [
      id,
      userId,
    ]);
    await c.query(
      "INSERT INTO lesson_versions(lesson_id,user_id,version,parent_version,rule,scope,approval,status,effective_at,originating_correction) VALUES($1,$2,1,NULL,$3,$4,'approved','active',NOW(),$5)",
      [
        id,
        userId,
        input.rule,
        JSON.stringify(input.scope),
        input.sourceRunId ?? null,
      ],
    );
    const result = { lessonId: id, version: 1 };
    await c.query(
      "INSERT INTO outbox(operation_key,user_id,kind,payload) VALUES($1,$2,'lesson.version.created',$3)",
      [
        JSON.stringify(["lesson", id, 1]),
        userId,
        JSON.stringify({ ...result, memoryConsent: true }),
      ],
    );
    await c.query(
      "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
      [userId, input.requestId, hash, JSON.stringify(result)],
    );
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function listLessons(pool: Pool, userId: string) {
  const result = await pool.query(
    `SELECT v.*,l.id,CASE WHEN o.payload->'memoryConsent'='true'::jsonb THEN o.state ELSE 'not_requested' END AS sync_state,o.outcome AS sync_receipt,o.attempts FROM lessons l JOIN lesson_versions v ON v.lesson_id=l.id AND v.user_id=l.user_id AND v.version=l.current_version LEFT JOIN outbox o ON o.user_id=l.user_id AND o.kind='lesson.version.created' AND o.payload->>'lessonId'=l.id AND o.payload->>'version'=l.current_version::text WHERE l.user_id=$1 ORDER BY v.effective_at DESC,l.id LIMIT 500`,
    [userId],
  );
  return result.rows.map((r) => ({
    lesson: lessonRowToPayload(r),
    sync: {
      state: r.sync_state ?? "not_requested",
      receipt: r.sync_receipt ?? null,
      attempts: r.attempts ?? 0,
    },
  }));
}
export async function updateReviewedLesson(
  pool: Pool,
  userId: string,
  lessonId: string,
  value: unknown,
) {
  const input = lessonUpdateSchema.parse(value);
  const row = (
    await pool.query(
      "SELECT v.* FROM lessons l JOIN lesson_versions v ON v.lesson_id=l.id AND v.user_id=l.user_id AND v.version=l.current_version WHERE l.id=$1 AND l.user_id=$2",
      [lessonId, userId],
    )
  ).rows[0];
  if (!row) throw new Error("NOT_FOUND");
  // Load the reviewed base, so a successful retry hashes the original payload.
  const base = (
    await pool.query(
      "SELECT * FROM lesson_versions WHERE lesson_id=$1 AND user_id=$2 AND version=$3",
      [lessonId, userId, input.baseVersion],
    )
  ).rows[0];
  if (!base) throw new Error("NOT_FOUND");
  if (base.status === "retired") throw new DomainConflict("LESSON_RETIRED");
  const {
    id: _id,
    userId: _userId,
    version: _version,
    parentVersion: _parentVersion,
    ...next
  } = lessonRowToPayload(base);
  void _id;
  void _userId;
  void _version;
  void _parentVersion;
  return commitLessonVersion(pool, {
    userId,
    lessonId,
    baseVersion: input.baseVersion,
    requestId: input.requestId,
    memoryConsent: input.action === "edit" || input.action === "active",
    next: {
      ...next,
      ...(input.action === "edit"
        ? { rule: input.rule, scope: input.scope }
        : { status: input.action }),
    },
  });
}
