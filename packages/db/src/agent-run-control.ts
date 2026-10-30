import type { Pool } from "pg";
import { z } from "zod";
import { researchAuditSchema } from "../../agent/src/memory-policy";
import { replySchema } from "../../agent/src/context";
import { sessionMemory } from "./chat-sessions";
import { RunConflict } from "./agent-runs";
import { outcomeReviewSchema } from "../../domain/src/reason-review";
import { memoryComparisonSchema } from "../../domain/src/memory-comparison";
export const cancelRunSchema = z
  .object({
    confirmed: z.literal(true),
    requestId: z.uuid(),
    expectedRevision: z.literal(1),
  })
  .strict();
const text = z.string().max(12000);
const resultSchema = z.object({
  researchAudit: researchAuditSchema.optional(),
  sessionId: z.uuid().optional(),
  marketRef: z
    .object({
      platform: z.enum(["kalshi", "polymarket"]),
      nativeId: z.string(),
    })
    .optional(),
  marketQuestion: z.string().max(2000).optional(),
  sessionMemories: z
    .array(
      z.object({
        sessionId: z.uuid(),
        version: z.number().int().positive(),
        blobId: z.string(),
        recordedAt: z.string(),
        payload: sessionMemory,
      }),
    )
    .max(4)
    .optional(),
  plannedTools: z.array(z.string()).max(5).optional(),
  recalledSources: z
    .array(
      z.object({
        id: text,
        version: z.number().int().positive(),
        sourceName: text,
        kind: z.enum(["market_baseline", "user_reported_forecaster"]),
        cohort: text,
        performance: z.object({
          scored: z.number().int().nonnegative(),
          matched: z.number().int().nonnegative(),
          meanBrier: z.number().min(0).max(1).nullable(),
        }),
      }),
    )
    .max(4)
    .optional(),
  reply: replySchema,
  trace: z
    .array(
      z.object({
        tool: z.enum([
          "read_market",
          "read_saved_pick",
          "read_approved_lessons",
          "compare_snapshot",
          "read_independent_sources",
          "read_settlement",
          "read_tatum_quote",
          "read_tatum_history",
          "recall_source_history",
          "recall_conversations",
        ]),
        status: z.enum(["completed", "unavailable"]),
        count: z.number().int().nonnegative(),
      }),
    )
    .max(10),
  sources: z
    .array(z.object({ id: text, url: z.string().max(4000), retrievedAt: text }))
    .max(20),
  usedLessons: z
    .array(
      z.object({
        id: text,
        version: z.number().int(),
        rule: text,
        scope: z.object({
          domain: text,
          competition: text.optional(),
          sourceClass: text.optional(),
        }),
      }),
    )
    .max(50),
  pick: z
    .object({
      id: text,
      version: z.number().int(),
      outcome: text,
      reason: text,
    })
    .nullable(),
  memoryState: z.enum(["not_requested", "account_only", "walrus_recalled"]),
  memoryComparison: memoryComparisonSchema.optional(),
  outcomeReview: outcomeReviewSchema.nullable().optional(),
});
export type RunState = {
  runId: string;
  status: "running" | "completed" | "failed";
  revision: 1 | 2;
  result: unknown;
};
export function publicRunState(row: {
  id: string;
  status: string;
  result: unknown;
}): RunState {
  const status = row.status as RunState["status"];
  const parsed = resultSchema.safeParse(row.result);
  return {
    runId: row.id,
    status,
    revision: status === "running" ? 1 : 2,
    result:
      status === "running"
        ? null
        : status === "completed"
          ? parsed.success
            ? parsed.data
            : null
          : {
              error:
                (row.result as { error?: unknown } | null)?.error ===
                "CANCELLED"
                  ? "CANCELLED"
                  : "AGENT_UNAVAILABLE",
            },
  };
}
export async function readRun(pool: Pool, userId: string, id: string) {
  await pool.query(
    "UPDATE agent_runs SET status='failed',result='{}'::jsonb,finished_at=now() WHERE user_id=$1 AND id=$2 AND status='running' AND created_at<now()-interval '5 minutes'",
    [userId, id],
  );
  const rows = await pool.query(
    "SELECT id,status,result FROM agent_runs WHERE user_id=$1 AND id=$2",
    [userId, id],
  );
  return rows.rows[0] ? publicRunState(rows.rows[0]) : null;
}
export async function cancelRun(
  pool: Pool,
  userId: string,
  id: string,
  input: z.infer<typeof cancelRunSchema>,
) {
  cancelRunSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      "SELECT id,status,result FROM agent_runs WHERE user_id=$1 AND id=$2 FOR UPDATE",
      [userId, id],
    );
    const row = found.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    if (row.status !== "running") {
      if (
        row.result?.error !== "CANCELLED" ||
        row.result?.cancelRequestId !== input.requestId
      )
        throw new RunConflict("RUN_NO_LONGER_ACTIVE");
    } else {
      const result = { error: "CANCELLED", cancelRequestId: input.requestId };
      await client.query(
        "UPDATE agent_runs SET status='failed',result=$3,finished_at=NOW() WHERE user_id=$1 AND id=$2 AND status='running'",
        [userId, id, JSON.stringify(result)],
      );
      row.status = "failed";
      row.result = result;
    }
    await client.query("COMMIT");
    return publicRunState(row);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
export async function streamRunEvents(options: {
  read: () => Promise<RunState | null>;
  emit: (event: string) => void;
  signal: AbortSignal;
  lastEventId?: string;
  pollMs?: number;
  maxMs?: number;
}) {
  const deadline = Date.now() + Math.min(25000, options.maxMs ?? 24000);
  let last =
    options.lastEventId === "1" ? 1 : options.lastEventId === "2" ? 2 : 0;
  let heartbeat = Date.now();
  while (!options.signal.aborted && Date.now() < deadline) {
    const state = await options.read();
    if (options.signal.aborted) return;
    if (!state) {
      options.emit("event: unavailable\ndata: {}\n\n");
      return;
    }
    if (state.revision > last) {
      options.emit(
        `id: ${state.revision}\nevent: status\ndata: ${JSON.stringify(state)}\n\n`,
      );
      last = state.revision;
    }
    if (state.status !== "running") return;
    if (Date.now() - heartbeat >= 5000) {
      options.emit(": heartbeat\n\n");
      heartbeat = Date.now();
    }
    await pause(
      Math.min(options.pollMs ?? 750, Math.max(0, deadline - Date.now())),
      options.signal,
    );
  }
}
