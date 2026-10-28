import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type {
  MemwalAdapter,
  MemoryRecord,
} from "../../integrations/src/memwal";
export const sessionMemory = z.object({
  sessionId: z.uuid(),
  segment: z.number().int().nonnegative().optional(),
  title: z.string().max(160),
  turns: z
    .array(
      z.object({
        runId: z.string(),
        platform: z.string(),
        nativeId: z.string(),
        question: z.string().max(2000),
        user: z.string().max(4000),
        reply: z.string().max(6000),
        at: z.string(),
        evidenceRefs: z.array(z.string()).max(20),
        evidence: z
          .array(
            z.object({
              id: z.string(),
              url: z.url().max(2000),
              retrievedAt: z.string(),
            }),
          )
          .max(20)
          .optional(),
        savedPick: z
          .object({
            outcome: z.string(),
            reason: z.string().max(4000),
            version: z.number().int().positive(),
          })
          .nullable()
          .optional(),
        unresolved: z.array(z.string().max(1000)).max(4).optional(),
        plannedTools: z.array(z.string()).max(5).optional(),
      }),
    )
    .max(40),
});
export async function createChatSession(
  pool: Pool,
  userId: string,
  consent: boolean,
) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO conversations(id,user_id,memory_consent) VALUES($1,$2,$3)",
    [id, userId, consent],
  );
  return { id, title: "New chat", memoryConsent: consent };
}
export async function listChatSessions(pool: Pool, userId: string) {
  return (
    await pool.query(
      `SELECT c.id,c.title,c.memory_consent AS "memoryConsent",c.updated_at AS "updatedAt",(SELECT state FROM conversation_memories m WHERE m.conversation_id=c.id ORDER BY version DESC LIMIT 1) AS "memoryState" FROM conversations c WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100`,
      [userId],
    )
  ).rows;
}
export async function chatHistory(pool: Pool, userId: string, id: string) {
  const owner = await pool.query(
    "SELECT id,title,memory_consent FROM conversations WHERE id=$1 AND user_id=$2",
    [id, userId],
  );
  if (!owner.rows.length) throw new Error("SESSION_NOT_FOUND");
  const rows = await pool.query(
    `SELECT * FROM (SELECT r.id,r.message,r.result,r.created_at,r.status,r.platform,r.native_id FROM agent_runs r WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100) t ORDER BY created_at,id`,
    [userId, id],
  );
  return rows.rows;
}
/** Runs inside the transaction that completes the turn; crash cannot lose its memory checkpoint. */
export async function checkpointSession(
  c: PoolClient,
  userId: string,
  id: string,
) {
  const session = (
    await c.query(
      "SELECT title,memory_consent FROM conversations WHERE user_id=$1 AND id=$2 FOR UPDATE",
      [userId, id],
    )
  ).rows[0];
  if (!session?.memory_consent) return;
  const count = Number(
    (
      await c.query(
        "SELECT count(*) AS n FROM agent_runs WHERE user_id=$1 AND conversation_id=$2 AND status='completed'",
        [userId, id],
      )
    ).rows[0].n,
  );
  const segment = Math.floor((count - 1) / 20);
  const rows = (
    await c.query(
      "SELECT id,platform,native_id,message,result,created_at FROM agent_runs WHERE user_id=$1 AND conversation_id=$2 AND status='completed' ORDER BY created_at,id OFFSET $3 LIMIT 20",
      [userId, id, Math.max(0, segment * 20)],
    )
  ).rows;
  if (!rows.length) return;
  const payload = sessionMemory.parse({
    sessionId: id,
    segment,
    title: session.title,
    turns: rows.map((r) => ({
      runId: r.id,
      platform: r.platform ?? "unknown",
      nativeId: r.native_id ?? "unknown",
      question: String(r.result?.marketQuestion ?? "").slice(0, 2000),
      user: r.message,
      reply: String(r.result?.reply?.message ?? "").slice(0, 6000),
      at: r.created_at.toISOString(),
      evidence: (r.result?.sources ?? [])
        .filter(
          (e: { url: string }) => z.url().max(2000).safeParse(e.url).success,
        )
        .slice(0, 20),
      savedPick: r.result?.pick
        ? {
            outcome: r.result.pick.outcome,
            reason: r.result.pick.reason,
            version: r.result.pick.version,
          }
        : null,
      unresolved: (r.result?.reply?.reasonReview?.claims ?? [])
        .filter((c: { status: string }) => c.status === "unclear")
        .slice(0, 4)
        .map((c: { claim: string }) => c.claim.slice(0, 1000)),
      plannedTools: (r.result?.plannedTools ?? []).slice(0, 5),
      evidenceRefs: (r.result?.sources ?? [])
        .slice(0, 20)
        .map((s: { id: string }) => s.id),
    })),
  });
  const version = Number(
    (
      await c.query(
        "SELECT COALESCE(MAX(version),0)+1 AS version FROM conversation_memories WHERE conversation_id=$1",
        [id],
      )
    ).rows[0].version,
  );
  await c.query(
    "INSERT INTO conversation_memories(conversation_id,user_id,version,payload,recorded_at) VALUES($1,$2,$3,$4,now())",
    [id, userId, version, JSON.stringify(payload)],
  );
}
export async function syncChatMemory(
  pool: Pool,
  adapter: MemwalAdapter,
  userId: string,
) {
  const claim = await pool.query(
    `UPDATE conversation_memories m SET state='processing',attempts=attempts+1,lease_until=now()+interval '120 seconds' WHERE (conversation_id,version)=(SELECT v.conversation_id,v.version FROM conversation_memories v JOIN conversations c ON c.id=v.conversation_id AND c.user_id=v.user_id WHERE v.user_id=$1 AND c.memory_consent=true AND ((v.state IN ('pending','retry') AND (retry_at IS NULL OR retry_at<=now())) OR (v.state='processing' AND lease_until<now())) ORDER BY v.recorded_at FOR UPDATE OF v SKIP LOCKED LIMIT 1) RETURNING m.*`,
    [userId],
  );
  const row = claim.rows[0];
  if (!row) return { state: "idle" };
  const record: MemoryRecord = {
    logicalId: conversationLogicalId(sessionMemory.parse(row.payload)),
    type: "conversation.session",
    version: row.version,
    recordedAt: row.recorded_at.toISOString(),
    payload: z
      .json()
      .parse(JSON.parse(JSON.stringify(sessionMemory.parse(row.payload)))),
  };
  const result = await adapter.remember(record);
  await pool.query(
    `UPDATE conversation_memories SET state=$4,blob_id=$5,hash=$6,lease_until=NULL,retry_at=CASE WHEN $4='retry' THEN now()+interval '1 minute' ELSE NULL END WHERE conversation_id=$1 AND user_id=$2 AND version=$3 AND attempts=$7 AND state='processing'`,
    [
      row.conversation_id,
      userId,
      row.version,
      result.status === "verified" ? "verified" : "retry",
      "blobId" in result ? result.blobId : null,
      "hash" in result ? result.hash : null,
      row.attempts,
    ],
  );
  return {
    state: result.status === "verified" ? "verified" : "retry",
    sessionId: row.conversation_id,
    version: row.version,
    ...("blobId" in result ? { blobId: result.blobId } : {}),
  };
}
export async function recallChatMemories(
  pool: Pool,
  adapter: MemwalAdapter,
  userId: string,
  currentId: string,
  query: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hits = await Promise.race([
    adapter.recall(query),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("SESSION_RECALL_TIMEOUT")),
        15000,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  const memories: {
    sessionId: string;
    version: number;
    blobId: string;
    recordedAt: string;
    payload: z.infer<typeof sessionMemory>;
  }[] = [];
  for (const hit of hits.sources) {
    const r = hit.record;
    if (r.type !== "conversation.session") continue;
    const parsed = sessionMemory.safeParse(r.payload);
    if (
      !parsed.success ||
      parsed.data.sessionId === currentId ||
      r.logicalId !== conversationLogicalId(parsed.data)
    )
      continue;
    const owned = (
      await pool.query(
        `SELECT m.payload,m.hash,m.blob_id FROM conversation_memories m JOIN conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id WHERE m.user_id=$1 AND m.conversation_id=$2 AND m.version=$3 AND m.state='verified' AND c.memory_consent=true AND m.version=(SELECT max(v.version) FROM conversation_memories v WHERE v.conversation_id=m.conversation_id AND v.state='verified' AND COALESCE(v.payload->>'segment','legacy')=COALESCE(m.payload->>'segment','legacy'))`,
        [userId, parsed.data.sessionId, r.version],
      )
    ).rows[0];
    if (
      !owned ||
      owned.hash !== r.hash ||
      owned.blob_id !== hit.blobId ||
      !isDeepStrictEqual(owned.payload, r.payload)
    )
      continue;
    if (memories.some((m) => m.sessionId === parsed.data.sessionId)) continue;
    memories.push({
      sessionId: parsed.data.sessionId,
      version: r.version,
      blobId: hit.blobId,
      recordedAt: r.recordedAt,
      payload: {
        ...parsed.data,
        turns: relevantTurns(parsed.data.turns, query),
      },
    });
    if (memories.length >= 4) break;
  }
  while (JSON.stringify(memories).length > 24000 && memories.length) {
    const last = memories.at(-1)!;
    if (last.payload.turns.length > 1) last.payload.turns.pop();
    else memories.pop();
  }
  return memories;
}
export function conversationLogicalId(payload: z.infer<typeof sessionMemory>) {
  return `conversation:${payload.sessionId}${payload.segment === undefined ? "" : `:segment:${payload.segment}`}`;
}

/** Keep early relevant markets, rather than only the last market in a long chat. */
function relevantTurns(
  turns: z.infer<typeof sessionMemory>["turns"],
  query: string,
) {
  const tokens = new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  return turns
    .map((turn, index) => ({
      turn,
      index,
      score: [...tokens].reduce(
        (sum, token) =>
          sum +
          Number(
            `${turn.question} ${turn.user} ${turn.nativeId}`
              .toLowerCase()
              .includes(token),
          ),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index)
    .map(({ turn }) => ({
      ...turn,
      user: turn.user.slice(0, 900),
      reply: turn.reply.slice(0, 900),
      ...(turn.evidence
        ? {
            evidence: turn.evidence
              .slice(0, 2)
              .map((e) => ({ ...e, url: e.url.slice(0, 500) })),
          }
        : {}),
      ...(turn.savedPick
        ? {
            savedPick: {
              ...turn.savedPick,
              reason: turn.savedPick.reason.slice(0, 900),
            },
          }
        : {}),
      ...(turn.unresolved
        ? {
            unresolved: turn.unresolved.slice(0, 2).map((s) => s.slice(0, 300)),
          }
        : {}),
    }));
}
