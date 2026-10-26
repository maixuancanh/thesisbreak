import { z } from "zod";
const scope = z
  .object({
    domain: z.string().trim().min(1).max(128),
    competition: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
const rule = z.string().trim().min(1).max(2000);
const review = { requestId: z.uuid(), confirmed: z.literal(true) };
export const lessonCreateSchema = z
  .object({
    ...review,
    rule,
    scope,
    memoryConsent: z.literal(true),
    sourceRunId: z.uuid().optional(),
  })
  .strict();
export const lessonUpdateSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...review,
      baseVersion: z.number().int().positive(),
      action: z.literal("edit"),
      rule,
      scope,
      memoryConsent: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...review,
      baseVersion: z.number().int().positive(),
      action: z.enum(["paused", "retired"]),
    })
    .strict(),
  z
    .object({
      ...review,
      baseVersion: z.number().int().positive(),
      action: z.literal("active"),
      memoryConsent: z.literal(true),
    })
    .strict(),
]);
export function lessonReceipt(
  previous: { fingerprint: string; requestId: string } | null,
  value: unknown,
  uuid: () => string,
) {
  const fingerprint = JSON.stringify(value);
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, requestId: uuid() };
}
