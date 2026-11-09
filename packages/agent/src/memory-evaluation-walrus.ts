import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import type { MemwalAdapter } from "../../integrations/src/memwal";
import {
  conversationLogicalId,
  sessionMemory,
} from "../../db/src/chat-sessions";
import {
  benchmarkMemorySchema,
  memoryRejection,
  type MemoryBenchmarkCase,
  type MemoryHit,
} from "../../domain/src/memory-benchmark";

export const memoryRecallManifestSchema = z
  .object({
    purpose: z.literal("authorized_synthetic_memory_evaluation"),
    records: z.array(
      z
        .object({
          fixtureId: z.string(),
          namespace: z.string().startsWith("eval:"),
          pointer: benchmarkMemorySchema,
          sessionId: z.string().uuid(),
          version: z.number().int().positive(),
          walrusNamespace: z.string(),
          blobId: z.string(),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict();

/** Only exact remote wording becomes a returned pointer. Rejected fixture pointers are never local fallbacks. */
export function createExactMemoryRecall(input: {
  pool: Pick<Pool, "query">;
  manifest: z.infer<typeof memoryRecallManifestSchema>;
  adapterForOwner: (ownerId: string) => MemwalAdapter;
  onProof?: (proof: unknown) => Promise<void>;
}) {
  const manifest = memoryRecallManifestSchema.parse(input.manifest);
  return async (fixture: MemoryBenchmarkCase): Promise<MemoryHit[]> => {
    const eligible = fixture.memories.filter(
      (pointer) => !memoryRejection(fixture, pointer),
    );
    const returned: MemoryHit[] = [];
    for (const pointer of eligible) {
      const entries = manifest.records.filter(
        (entry) =>
          entry.fixtureId === fixture.id && entry.pointer.id === pointer.id,
      );
      if (entries.length !== 1)
        throw Error("EXACT_MEMORY_POINTER_MANIFEST_REQUIRED");
      const entry = entries[0]!;
      if (
        entry.namespace !== fixture.namespace ||
        entry.pointer.ownerId !== fixture.ownerId ||
        !isDeepStrictEqual(entry.pointer, pointer)
      )
        throw Error("EVALUATION_POINTER_OWNER_NAMESPACE_VERSION_TEXT_MISMATCH");
      const adapter = input.adapterForOwner(fixture.ownerId);
      if (adapter.namespace !== entry.walrusNamespace)
        throw Error("WALRUS_NAMESPACE_MISMATCH");
      const readAuthorized = async () =>
        (
          await input.pool.query(
            `SELECT m.* FROM conversation_memories m JOIN conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
         WHERE m.user_id=$1 AND m.conversation_id=$2 AND m.version=$3 AND c.memory_consent=true AND m.state='verified'
         AND m.version=(SELECT max(v.version) FROM conversation_memories v WHERE v.user_id=m.user_id
           AND v.conversation_id=m.conversation_id AND v.state='verified'
           AND COALESCE(v.payload->>'segment','legacy')=COALESCE(m.payload->>'segment','legacy'))`,
            [fixture.ownerId, entry.sessionId, entry.version],
          )
        ).rows[0];
      const owned = await readAuthorized();
      if (!owned || owned.hash !== entry.hash || owned.blob_id !== entry.blobId)
        throw Error("CURRENT_AUTHORIZED_RECEIPT_REQUIRED");
      const payload = sessionMemory.parse(owned.payload);
      if (
        payload.sessionId !== entry.sessionId ||
        !payload.turns.some((turn) => turn.user === pointer.text)
      )
        throw Error("EXACT_POINTER_WORDING_REQUIRED");
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
          source.record.type === record.type &&
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
      const turn = sessionMemory
        .parse(hit.record.payload)
        .turns.find((item) => item.user === pointer.text);
      if (!turn) throw Error("EXACT_REMOTE_WORDING_REQUIRED");
      await input.onProof?.({
        fixtureId: fixture.id,
        memoryId: pointer.id,
        pointerVersion: pointer.version,
        pointerHash: createHash("sha256")
          .update(JSON.stringify(pointer))
          .digest("hex"),
        namespace: adapter.namespace,
        blobId: hit.blobId,
        hash: hit.record.hash,
        version: entry.version,
      });
      returned.push({ ...structuredClone(pointer), text: turn.user });
    }
    return returned;
  };
}
