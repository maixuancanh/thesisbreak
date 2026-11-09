import { z } from "zod";
const id = z.string().trim().min(1).max(300);
const time = z.iso.datetime({ offset: true });
export const evidenceRefSchema = z
  .object({
    id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    originId: id,
    url: z.url().refine((s) => new URL(s).protocol === "https:"),
    observedAt: time,
    publishedAt: time.nullable(),
    availableAt: time,
    eventId: id,
  })
  .strict();
export const researchEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: id,
    namespace: id,
    mode: z.enum(["synthetic", "historical_replay", "prospective"]),
    ownerId: id,
    eventId: id,
    marketId: id,
    outcomeId: id,
    cutoffAt: time,
    eventStartAt: time,
    evidence: z.array(evidenceRefSchema).min(1).max(100),
    modelVersion: id,
    procedureVersion: id,
    maxCalls: z.number().int().min(1).max(20),
    maxOutputTokens: z.number().int().min(1).max(32000),
  })
  .strict()
  .superRefine((v, ctx) => {
    const reject = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (Date.parse(v.cutoffAt) >= Date.parse(v.eventStartAt))
      reject("CUTOFF_NOT_PRE_EVENT");
    if (new Set(v.evidence.map((e) => e.id)).size !== v.evidence.length)
      reject("DUPLICATE_EVIDENCE");
    for (const e of v.evidence) {
      if (e.eventId !== v.eventId) reject("EVENT_MISMATCH");
      if (Date.parse(e.observedAt) > Date.parse(e.availableAt))
        reject("INVALID_AVAILABILITY");
      if (Date.parse(e.availableAt) > Date.parse(v.cutoffAt))
        reject("FUTURE_EVIDENCE");
      if (
        e.publishedAt !== null &&
        Date.parse(e.publishedAt) > Date.parse(e.observedAt)
      )
        reject("INVALID_PUBLICATION_TIME");
      if (v.mode === "historical_replay" && e.publishedAt === null)
        reject("REPLAY_PUBLICATION_REQUIRED");
    }
  });
export const memoryPointerSchema = z
  .object({
    ownerId: id,
    memoryId: id,
    version: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    blobId: id,
  })
  .strict();
export const componentForecastSchema = z
  .object({
    componentId: id,
    probability: z.number().finite().min(0).max(1).nullable(),
    status: z.enum(["ok", "abstained", "failed"]),
    evidenceIds: z.array(id).max(100),
    originIds: z.array(id).max(100),
    assumptions: z.array(z.string().max(2000)).max(20),
    failureCode: id.nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.status === "ok") !== (v.probability !== null))
      ctx.addIssue({ code: "custom", message: "PROBABILITY_STATUS_MISMATCH" });
    if ((v.status === "failed") !== (v.failureCode !== null))
      ctx.addIssue({ code: "custom", message: "FAILURE_CODE_STATUS_MISMATCH" });
  });
export type ResearchEnvelope = z.infer<typeof researchEnvelopeSchema>;
export type MemoryPointer = z.infer<typeof memoryPointerSchema>;
export type ComponentForecast = z.infer<typeof componentForecastSchema>;
export function aggregateForecasts(input: unknown[]) {
  const rows = input.map((v) => componentForecastSchema.parse(v));
  const valid = rows.filter((v) => v.status === "ok");
  const values = valid.map((v) => v.probability!).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const probability =
    values.length < 2
      ? null
      : values.length % 2
        ? values[middle]!
        : (values[middle - 1]! + values[middle]!) / 2;
  return {
    probability,
    attempted: rows.length,
    succeeded: valid.length,
    independentOrigins: new Set(valid.flatMap((v) => v.originIds)).size,
  };
}
