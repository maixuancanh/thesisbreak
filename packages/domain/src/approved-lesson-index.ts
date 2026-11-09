import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { lessonVersionSchema } from "./lesson";
import { memoryEdgeSchema, type MemoryEdge } from "./memory-index";
export const APPROVED_LESSON_INDEX_NAMESPACE = "owner:approved-lessons";
const envelopeSchema = z.object({
  schema: z.literal(1),
  userId: z.string(),
  logicalId: z.string(),
  type: z.literal("lesson"),
  version: z.number().int(),
  recordedAt: z.iso.datetime(),
  payload: lessonVersionSchema,
  hash: z.string(),
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Receipt bytes, reviewed payload, and server-captured native event schedule must agree. No text/date inference. */
export function approvedLessonEdges(input: {
  lesson: unknown;
  record: unknown;
  receipt: unknown;
  materializedAt: string;
  events: {
    provider: string;
    eventId: string;
    scheduledAt: string;
    evidenceId: string;
    recordedAt: string;
  }[];
}): MemoryEdge[] {
  const lesson = lessonVersionSchema.safeParse(input.lesson);
  const record = envelopeSchema.safeParse(input.record);
  const receipt = z
    .object({
      status: z.literal("verified"),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      blobId: z.string().min(1),
    })
    .safeParse(input.receipt);
  if (!lesson.success || !record.success || !receipt.success) return [];
  if (!z.iso.datetime({ offset: true }).safeParse(input.materializedAt).success)
    return [];
  const l = lesson.data,
    r = record.data;
  const { hash, ...body } = r;
  if (
    l.userId !== r.userId ||
    l.id !== r.logicalId ||
    l.version !== r.version ||
    !isDeepStrictEqual(l, r.payload) ||
    l.approval !== "approved" ||
    l.status !== "active" ||
    l.supersededBy !== null ||
    hash !== receipt.data.hash ||
    createHash("sha256").update(canonical(body)).digest("hex") !== hash
  )
    return [];
  return input.events.flatMap((event) => {
    if (
      !z.iso.datetime({ offset: true }).safeParse(event.scheduledAt).success ||
      !z.iso.datetime({ offset: true }).safeParse(event.recordedAt).success ||
      (l.learningScope?.eventId && l.learningScope.eventId !== event.eventId)
    )
      return [];
    const edge = memoryEdgeSchema.safeParse({
      id: createHash("sha256")
        .update(
          JSON.stringify([
            l.id,
            l.version,
            event.provider,
            event.eventId,
            event.scheduledAt.slice(0, 10),
          ]),
        )
        .digest("hex"),
      namespace: APPROVED_LESSON_INDEX_NAMESPACE,
      pointer: {
        ownerId: l.userId,
        memoryId: l.id,
        version: l.version,
        sha256: hash,
        blobId: receipt.data.blobId,
      },
      event: {
        provider: event.provider,
        nativeId: event.eventId,
        date: event.scheduledAt.slice(0, 10),
      },
      entities: [
        { kind: "event", provider: event.provider, nativeId: event.eventId },
        {
          kind: l.learningCondition ? "condition" : "reason",
          provider: "thesisbreak",
          nativeId: l.id,
        },
      ],
      relation: l.learningCondition?.type ?? "approved_rule",
      text: l.rule,
      evidenceIds: [event.evidenceId],
      recordedAt: r.recordedAt,
      availableAt: new Date(
        Math.max(
          Date.parse(r.recordedAt),
          Date.parse(event.recordedAt),
          Date.parse(input.materializedAt),
        ),
      ).toISOString(),
      validFrom: l.effectiveAt,
      validTo: l.expiresAt,
      trusted: true,
      scope: {
        domain: l.scope.domain,
        ...(l.scope.competition ? { competition: l.scope.competition } : {}),
        ...(l.learningScope?.marketType
          ? { marketType: l.learningScope.marketType }
          : {}),
        ...(l.learningScope?.horizon
          ? { horizon: l.learningScope.horizon }
          : {}),
      },
    });
    return edge.success ? [edge.data] : [];
  });
}
