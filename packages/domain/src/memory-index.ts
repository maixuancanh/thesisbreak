import { z } from "zod";
import { memoryPointerSchema } from "./strengthening-contracts";
const id = z.string().min(1).max(300);
const time = z.iso.datetime({ offset: true });
const scopeSchema = z
  .object({
    domain: id.optional(),
    competition: id.optional(),
    marketId: id.optional(),
    marketType: id.optional(),
    horizon: id.optional(),
  })
  .strict();
export const entityRefSchema = z
  .object({
    kind: z.enum(["team", "player", "source", "event", "reason", "condition"]),
    provider: id,
    nativeId: id,
  })
  .strict();
export const nativeEventSchema = z
  .object({ provider: id, nativeId: id, date: z.iso.date() })
  .strict();
export const memoryEdgeSchema = z
  .object({
    id,
    namespace: id,
    pointer: memoryPointerSchema,
    event: nativeEventSchema,
    entities: z.array(entityRefSchema).max(40),
    relation: id,
    text: z.string().max(16000),
    evidenceIds: z.array(id).min(1).max(100),
    recordedAt: time,
    availableAt: time,
    validFrom: time,
    validTo: time.nullable(),
    trusted: z.boolean(),
    scope: scopeSchema.optional(),
  })
  .strict()
  .refine(
    (e) =>
      e.validTo === null || Date.parse(e.validTo) > Date.parse(e.validFrom),
    "INVALID_VALIDITY_INTERVAL",
  );
export type MemoryEdge = z.infer<typeof memoryEdgeSchema>;
export const memoryIndexQuerySchema = z
  .object({
    ownerId: id,
    namespace: id,
    event: nativeEventSchema,
    cutoffAt: time,
    query: z.string().max(12000),
    entities: z.array(entityRefSchema).max(40),
    topK: z.number().int().min(1).max(20).optional(),
    finalK: z.number().int().min(1).max(5).optional(),
    maxCharacters: z.number().int().min(0).max(16000).optional(),
    scope: scopeSchema.optional(),
  })
  .strict();
export type MemoryIndexQuery = z.infer<typeof memoryIndexQuerySchema>;
const entityKey = (e: z.infer<typeof entityRefSchema>) =>
  JSON.stringify([e.kind, e.provider, e.nativeId]);
/** Native provider IDs are identity. Text and aliases only rank already scoped records. */
export function rankMemoryEdges(
  rawQuery: MemoryIndexQuery,
  rawEdges: unknown[],
): MemoryEdge[] {
  const q = memoryIndexQuerySchema.parse(rawQuery);
  const cutoff = Date.parse(q.cutoffAt);
  const terms = [
    ...new Set(q.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  ];
  const entities = new Set(q.entities.map(entityKey));
  return rawEdges
    .flatMap((raw) => {
      const parsed = memoryEdgeSchema.safeParse(raw);
      if (!parsed.success) return [];
      const e = parsed.data;
      if (
        e.pointer.ownerId !== q.ownerId ||
        e.namespace !== q.namespace ||
        !e.trusted ||
        Object.entries(e.scope ?? {}).some(
          ([key, value]) =>
            q.scope?.[key as keyof NonNullable<typeof q.scope>] !== value,
        ) ||
        e.event.provider !== q.event.provider ||
        e.event.nativeId !== q.event.nativeId ||
        e.event.date !== q.event.date ||
        Date.parse(e.recordedAt) > cutoff ||
        Date.parse(e.availableAt) > cutoff ||
        Date.parse(e.validFrom) > cutoff ||
        (e.validTo !== null && Date.parse(e.validTo) <= cutoff)
      )
        return [];
      const score =
        terms.filter((t) => e.text.toLowerCase().includes(t)).length +
        e.entities.filter((x) => entities.has(entityKey(x))).length * 2;
      return score ? [{ e, score }] : [];
    })
    .sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id))
    .map((x) => x.e)
    .filter(
      (e, i, all) =>
        all.findIndex(
          (x) => JSON.stringify(x.pointer) === JSON.stringify(e.pointer),
        ) === i,
    )
    .slice(0, q.topK ?? 20);
}
