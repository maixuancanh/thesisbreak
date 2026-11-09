import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Pool } from "pg";
import type { MemwalAdapter } from "../../integrations/src/memwal";
import {
  conversationLogicalId,
  sessionMemory,
} from "../../db/src/chat-sessions";
import type { ActionBenchmarkCase } from "../../domain/src/action-benchmark";

export const actionRecallManifestSchema = z
  .object({
    purpose: z.literal("authorized_synthetic_action_evaluation"),
    records: z
      .array(
        z
          .object({
            fixtureId: z.string(),
            namespace: z.string().startsWith("eval:"),
            ownerId: z.string(),
            sessionId: z.string().uuid(),
            version: z.number().int().positive(),
            walrusNamespace: z.string(),
            blobId: z.string(),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** No consent creation, no persistence, no local-memory fallback. Called anew per memory arm. */
export function createExactActionRecall(input: {
  pool: Pick<Pool, "query">;
  manifest: z.infer<typeof actionRecallManifestSchema>;
  adapterForOwner: (ownerId: string) => MemwalAdapter;
}) {
  const manifest = actionRecallManifestSchema.parse(input.manifest);
  return async (fixture: ActionBenchmarkCase) => {
    const entries = manifest.records.filter((r) => r.fixtureId === fixture.id);
    if (entries.length !== 1) throw Error("EXACT_EVALUATION_RECORD_REQUIRED");
    const entry = entries[0]!;
    if (
      entry.ownerId !== fixture.ownerId ||
      entry.namespace !== fixture.namespace
    )
      throw Error("EVALUATION_OWNER_NAMESPACE_MISMATCH");
    const adapter = input.adapterForOwner(entry.ownerId);
    if (adapter.namespace !== entry.walrusNamespace)
      throw Error("WALRUS_NAMESPACE_MISMATCH");
    const readAuthorized = async () =>
      (
        await input.pool.query(
          `SELECT m.* FROM conversation_memories m JOIN conversations c
       ON c.id=m.conversation_id AND c.user_id=m.user_id
       WHERE m.user_id=$1 AND m.conversation_id=$2 AND m.version=$3
       AND c.memory_consent=true AND m.state='verified'
       AND m.version=(SELECT max(v.version) FROM conversation_memories v WHERE
         v.user_id=m.user_id AND v.conversation_id=m.conversation_id AND v.state='verified'
         AND COALESCE(v.payload->>'segment','legacy')=COALESCE(m.payload->>'segment','legacy'))`,
          [entry.ownerId, entry.sessionId, entry.version],
        )
      ).rows[0];
    const owned = await readAuthorized();
    if (!owned || owned.blob_id !== entry.blobId || owned.hash !== entry.hash)
      throw Error("CURRENT_AUTHORIZED_RECEIPT_REQUIRED");
    const payload = sessionMemory.parse(owned.payload);
    // Original exact fixture wording must exist in the remote record, never copied from local as fallback.
    if (!payload.turns.some((turn) => turn.user === fixture.memory))
      throw Error("EXACT_FIXTURE_WORDING_REQUIRED");
    const record = {
      logicalId: conversationLogicalId(payload),
      type: "conversation.session",
      version: entry.version,
      recordedAt: new Date(owned.recorded_at).toISOString(),
      payload: owned.payload,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const found = await Promise.race([
      adapter.recallRecord(record),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("EXACT_RECALL_TIMEOUT")), 7000);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const hit = found.sources.find(
      (source) =>
        source.blobId === entry.blobId &&
        source.record.hash === entry.hash &&
        source.record.logicalId === record.logicalId &&
        source.record.version === entry.version &&
        source.record.recordedAt === record.recordedAt &&
        isDeepStrictEqual(source.record.payload, owned.payload),
    );
    if (
      !hit ||
      found.conflicts.includes(`${record.logicalId}@${entry.version}`)
    )
      throw Error("EXACT_REMOTE_BYTES_REQUIRED");
    const current = await readAuthorized();
    if (
      !current ||
      current.hash !== owned.hash ||
      current.blob_id !== owned.blob_id ||
      !isDeepStrictEqual(current.payload, owned.payload)
    )
      throw Error("AUTHORITY_CHANGED_DURING_RECALL");
    const remotePayload = sessionMemory.parse(hit.record.payload);
    const turn = remotePayload.turns.find((row) => row.user === fixture.memory);
    if (!turn) throw Error("EXACT_REMOTE_WORDING_REQUIRED");
    return {
      text: turn.user,
      proof: {
        blobId: hit.blobId,
        hash: hit.record.hash,
        namespace: adapter.namespace,
        logicalId: record.logicalId,
        version: entry.version,
      },
    };
  };
}
