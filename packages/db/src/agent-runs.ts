import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { marketReferenceSchema } from "../../integrations/src/tatum/catalog";
import { checkpointSession } from "./chat-sessions";
export const agentMessageSchema = z
  .object({
    platform: z.enum(["kalshi", "polymarket"]),
    nativeId: z.string().min(1).max(128),
    provider: z.enum(["public", "tatum"]),
    message: z.string().trim().min(1).max(4000),
    requestId: z.uuid(),
    compareMemory: z.boolean().optional(),
    sessionId: z.uuid().optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      !marketReferenceSchema.safeParse({ platform: v.platform, id: v.nativeId })
        .success
    )
      c.addIssue({ code: "custom", message: "INVALID_MARKET" });
  });
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export class RunConflict extends Error {}
async function tx<T>(pool: Pool, f: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await f(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function claimRun(
  pool: Pool,
  userId: string,
  input: AgentMessage,
) {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return tx(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify(["agent-claim", userId]),
    ]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([userId, input.requestId]),
    ]);
    await c.query(
      "UPDATE agent_runs SET status='failed',finished_at=NOW() WHERE user_id=$1 AND status='running' AND created_at < NOW()-INTERVAL '5 minutes'",
      [userId],
    );
    const old = await c.query(
      "SELECT id,payload_hash,status,result,conversation_id FROM agent_runs WHERE user_id=$1 AND request_id=$2",
      [userId, input.requestId],
    );
    if (old.rows[0]) {
      if (old.rows[0].payload_hash !== hash)
        throw new RunConflict("REQUEST_ID_REUSED");
      return {
        fresh: false,
        id: old.rows[0].id as string,
        status: old.rows[0].status as string,
        result: old.rows[0].result,
        conversationId: old.rows[0].conversation_id as string,
      };
    }
    const rate = await c.query(
      "SELECT COUNT(*)::int AS count FROM agent_runs WHERE user_id=$1 AND created_at > NOW()-INTERVAL '1 hour'",
      [userId],
    );
    if (rate.rows[0]?.count >= 30) throw new RunConflict("RUN_LIMIT_REACHED");
    await c.query(
      "INSERT INTO markets(platform,native_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [input.platform, input.nativeId],
    );
    let conversation = input.sessionId;
    if (
      conversation &&
      !(
        await c.query(
          "SELECT id FROM conversations WHERE id=$1 AND user_id=$2",
          [conversation, userId],
        )
      ).rows.length
    )
      throw new RunConflict("SESSION_NOT_FOUND");
    if (!conversation)
      conversation = (
        await c.query(
          "SELECT id FROM conversations WHERE user_id=$1 AND platform=$2 AND native_id=$3 ORDER BY id LIMIT 1",
          [userId, input.platform, input.nativeId],
        )
      ).rows[0]?.id as string | undefined;
    if (!conversation) {
      conversation = randomUUID();
      await c.query(
        "INSERT INTO conversations(id,user_id,platform,native_id) VALUES($1,$2,$3,$4)",
        [conversation, userId, input.platform, input.nativeId],
      );
    }
    // A crashed run is failed on a subsequent request; it is never silently dispatched twice.
    await c.query(
      "UPDATE agent_runs SET status='failed',finished_at=NOW() WHERE user_id=$1 AND conversation_id=$2 AND status='running' AND created_at < NOW()-INTERVAL '5 minutes'",
      [userId, conversation],
    );
    if (
      (
        await c.query(
          "SELECT id FROM agent_runs WHERE user_id=$1 AND conversation_id=$2 AND status='running' LIMIT 1",
          [userId, conversation],
        )
      ).rows.length
    )
      throw new RunConflict("CONVERSATION_BUSY");
    const id = randomUUID();
    await c.query(
      "INSERT INTO agent_runs(id,user_id,conversation_id,request_id,payload_hash,provider,message,status,platform,native_id) VALUES($1,$2,$3,$4,$5,$6,$7,'running',$8,$9)",
      [
        id,
        userId,
        conversation,
        input.requestId,
        hash,
        input.provider,
        input.message,
        input.platform,
        input.nativeId,
      ],
    );
    return {
      fresh: true,
      id,
      status: "running",
      result: null,
      conversationId: conversation,
    };
  });
}
export async function finishRun(
  pool: Pool,
  userId: string,
  id: string,
  result: unknown,
  status: "completed" | "failed",
) {
  return tx(pool, async (c) => {
    const r = await c.query(
      "UPDATE agent_runs SET status=$4,result=$3,finished_at=NOW() WHERE user_id=$1 AND id=$2 AND status='running' RETURNING id,conversation_id,message",
      [userId, id, JSON.stringify(result), status],
    );
    if (!r.rows.length) throw new RunConflict("RUN_NO_LONGER_ACTIVE");
    if (status === "completed") {
      await c.query(
        "UPDATE conversations SET updated_at=now(),title=CASE WHEN title='New chat' THEN left($3,160) ELSE title END WHERE user_id=$1 AND id=$2",
        [userId, r.rows[0].conversation_id, r.rows[0].message],
      );
      await checkpointSession(c, userId, r.rows[0].conversation_id);
    }
  });
}
export async function conversationHistory(
  pool: Pool,
  userId: string,
  platform: string,
  nativeId: string,
) {
  const rows = await pool.query(
    "SELECT r.id,r.message,r.result,r.created_at,r.status FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.user_id=$1 AND c.platform=$2 AND c.native_id=$3 ORDER BY r.created_at DESC,r.id DESC LIMIT 10",
    [userId, platform, nativeId],
  );
  return rows.rows.reverse();
}
