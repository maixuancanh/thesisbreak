import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  DomainConflict,
  assumptionSchema,
  watchPlanSchema,
  lessonVersionSchema,
} from "../../domain/src/index";
const inputSchema = z
  .object({
    userId: z.string().min(1),
    pickId: z.string().min(1),
    baseVersion: z.number().int().positive(),
    requestId: z.string().min(1),
    changes: z
      .object({
        outcome: z.string().min(1).optional(),
        reason: z.string().nullable().optional(),
        assumptions: z.array(assumptionSchema).optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0),
  })
  .strict();
export interface CommitResult {
  pickId: string;
  version: number;
}
/** Trusted-server primitive. Confirmation endpoints must validate proposal consent and expiry first. */
export async function commitPickVersion(
  pool: Pool,
  value: z.input<typeof inputSchema>,
): Promise<CommitResult> {
  const input = inputSchema.parse(value);
  const { userId, pickId, baseVersion, requestId, changes } = input;
  // Parsed schema gives deterministic key ordering; a key cannot be reused for a different mutation.
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ pickId, baseVersion, changes }))
    .digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize the same user/request across different picks, then serialize each pick.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([userId, requestId]),
    ]);
    const previous = await client.query<{
      request_hash: string;
      result: CommitResult;
    }>(
      "SELECT request_hash,result FROM mutation_requests WHERE user_id=$1 AND request_id=$2",
      [userId, requestId],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== requestHash)
        throw new DomainConflict("IDEMPOTENCY_KEY_REUSED");
      await client.query("COMMIT");
      return previous.rows[0].result;
    }
    const pick = await client.query<{ current_version: number }>(
      "SELECT current_version FROM picks WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [pickId, userId],
    );
    if (!pick.rows[0]) throw new Error("NOT_FOUND");
    if (pick.rows[0].current_version !== baseVersion)
      throw new DomainConflict("VERSION_CONFLICT");
    const current = await client.query<{
      outcome: string;
      reason: string | null;
      assumptions: unknown;
      snapshot_id: string | null;
    }>(
      "SELECT outcome,reason,assumptions,snapshot_id FROM pick_versions WHERE pick_id=$1 AND user_id=$2 AND version=$3",
      [pickId, userId, baseVersion],
    );
    const old = current.rows[0];
    if (!old) throw new Error("MISSING_BASE_VERSION");
    const version = baseVersion + 1;
    const result = { pickId, version };
    await client.query(
      "INSERT INTO pick_versions(pick_id,user_id,version,parent_version,snapshot_id,outcome,reason,assumptions) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        pickId,
        userId,
        version,
        baseVersion,
        old.snapshot_id,
        changes.outcome ?? old.outcome,
        changes.reason === undefined ? old.reason : changes.reason,
        JSON.stringify(changes.assumptions ?? old.assumptions),
      ],
    );
    await client.query(
      "UPDATE picks SET current_version=$1 WHERE id=$2 AND user_id=$3",
      [version, pickId, userId],
    );
    await client.query(
      "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
      [userId, requestId, requestHash, JSON.stringify(result)],
    );
    await client.query(
      "INSERT INTO outbox(operation_key,user_id,kind,payload) VALUES($1,$2,$3,$4)",
      [
        JSON.stringify(["pick", pickId, version]),
        userId,
        "pick.version.created",
        JSON.stringify(result),
      ],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface MutationInput {
  userId: string;
  entityId: string;
  baseVersion: number;
  requestId: string;
}
const mutationIdentitySchema = z
  .object({
    userId: z.string().min(1),
    entityId: z.string().min(1),
    baseVersion: z.number().int().positive(),
    requestId: z.string().min(1),
  })
  .strict();
async function commitVersion<T extends Record<string, string | number>>(
  pool: Pool,
  input: MutationInput,
  options: {
    kind: "watch_plan" | "lesson";
    payload: unknown;
    result: T;
    memoryConsent?: boolean;
    write: (client: PoolClient, owner: { pick_id?: string }) => Promise<void>;
  },
): Promise<T> {
  mutationIdentitySchema.parse(input);
  const { userId, entityId, baseVersion, requestId } = input;
  const table = options.kind === "watch_plan" ? "watch_plans" : "lessons";
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        kind: options.kind,
        entityId,
        baseVersion,
        payload: options.payload,
        memoryConsent: options.memoryConsent === true,
      }),
    )
    .digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([userId, requestId]),
    ]);
    const previous = await client.query<{ request_hash: string; result: T }>(
      "SELECT request_hash,result FROM mutation_requests WHERE user_id=$1 AND request_id=$2",
      [userId, requestId],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== requestHash)
        throw new DomainConflict("IDEMPOTENCY_KEY_REUSED");
      await client.query("COMMIT");
      return previous.rows[0].result;
    }
    // Table is selected exclusively from the closed server-side enum above.
    const owner = await client.query<{
      current_version: number;
      pick_id?: string;
    }>("SELECT * FROM " + table + " WHERE id=$1 AND user_id=$2 FOR UPDATE", [
      entityId,
      userId,
    ]);
    const row = owner.rows[0];
    if (!row) throw new Error("NOT_FOUND");
    if (row.current_version !== baseVersion)
      throw new DomainConflict("VERSION_CONFLICT");
    await options.write(client, row);
    await client.query(
      "UPDATE " + table + " SET current_version=$1 WHERE id=$2 AND user_id=$3",
      [baseVersion + 1, entityId, userId],
    );
    await client.query(
      "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
      [userId, requestId, requestHash, JSON.stringify(options.result)],
    );
    await client.query(
      "INSERT INTO outbox(operation_key,user_id,kind,payload) VALUES($1,$2,$3,$4)",
      [
        JSON.stringify([options.kind, entityId, baseVersion + 1]),
        userId,
        options.kind + ".version.created",
        JSON.stringify({
          ...options.result,
          ...(options.memoryConsent ? { memoryConsent: true } : {}),
        }),
      ],
    );
    await client.query("COMMIT");
    return options.result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export interface WatchPlanMutation {
  userId: string;
  planId: string;
  baseVersion: number;
  requestId: string;
  next: Omit<
    z.input<typeof watchPlanSchema>,
    "id" | "version" | "parentVersion"
  >;
}
/** Persist a complete reviewed plan version; never silently merge unreviewed fields. */
export function commitWatchPlanVersion(
  pool: Pool,
  input: WatchPlanMutation,
): Promise<{ planId: string; version: number }> {
  const version = input.baseVersion + 1;
  const next = watchPlanSchema.parse({
    ...input.next,
    id: input.planId,
    version,
    parentVersion: input.baseVersion,
  });
  return commitVersion(
    pool,
    {
      userId: input.userId,
      entityId: input.planId,
      baseVersion: input.baseVersion,
      requestId: input.requestId,
    },
    {
      kind: "watch_plan",
      payload: next,
      result: { planId: input.planId, version },
      write: async (client, owner) => {
        if (owner.pick_id !== next.pickId)
          throw new DomainConflict("PLAN_PICK_MISMATCH");
        await client.query(
          "INSERT INTO watch_plan_versions(plan_id,user_id,version,parent_version,pick_id,pick_version,condition,source_ids,procedure_version,deadline,timezone,channel,approved_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            input.planId,
            input.userId,
            version,
            input.baseVersion,
            next.pickId,
            next.pickVersion,
            JSON.stringify(next.condition),
            JSON.stringify(next.sourceIds),
            next.procedureVersion,
            next.deadline,
            next.timezone,
            next.channel,
            next.approvedAt,
            next.state,
          ],
        );
      },
    },
  );
}
export interface LessonMutation {
  userId: string;
  lessonId: string;
  baseVersion: number;
  requestId: string;
  memoryConsent?: boolean;
  next: Omit<
    z.input<typeof lessonVersionSchema>,
    "id" | "userId" | "version" | "parentVersion"
  >;
}
/** Called after explicit user review; the model must never invoke this primitive directly. */
export function commitLessonVersion(
  pool: Pool,
  input: LessonMutation,
): Promise<{ lessonId: string; version: number }> {
  const version = input.baseVersion + 1;
  const next = lessonVersionSchema.parse({
    ...input.next,
    id: input.lessonId,
    userId: input.userId,
    version,
    parentVersion: input.baseVersion,
  });
  return commitVersion(
    pool,
    {
      userId: input.userId,
      entityId: input.lessonId,
      baseVersion: input.baseVersion,
      requestId: input.requestId,
    },
    {
      kind: "lesson",
      memoryConsent: input.memoryConsent === true,
      payload: next,
      result: { lessonId: input.lessonId, version },
      write: async (client) => {
        await client.query(
          "INSERT INTO lesson_versions(lesson_id,user_id,version,parent_version,rule,scope,approval,status,effective_at,expires_at,review_at,superseded_by,originating_correction) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [
            input.lessonId,
            input.userId,
            version,
            input.baseVersion,
            next.rule,
            JSON.stringify(next.scope),
            next.approval,
            next.status,
            next.effectiveAt,
            next.expiresAt,
            next.reviewAt ?? null,
            next.supersededBy,
            next.originatingCorrection ?? null,
          ],
        );
      },
    },
  );
}
