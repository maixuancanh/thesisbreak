import { z } from "zod";
const id = z.string().trim().min(1).max(300);
export const dataModeSchema = z.enum([
  "live",
  "acceptance_test",
  "replay",
  "synthetic",
]);
export const reasonConditionSchema = z
  .object({
    kind: z.enum([
      "official_lineup",
      "official_result",
      "source_correction",
      "manual_review",
    ]),
    subjectId: id,
    eventIds: z.array(id).min(1).max(20),
    statement: z.string().trim().min(1).max(1000),
    revisitWhen: z.string().trim().min(1).max(1000),
    predicate: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("lineup_status"),
          expected: z.enum(["starter", "available"]),
          revisitOn: z.enum(["not_starter", "unavailable"]),
        })
        .strict(),
      z
        .object({
          type: z.literal("source_revision"),
          referenceId: id,
          revisitOn: z.enum(["corrected", "withdrawn"]),
        })
        .strict(),
      z
        .object({
          type: z.literal("event_final"),
          revisitOn: z.literal("official_final"),
        })
        .strict(),
      z.object({ type: z.literal("manual") }).strict(),
    ]),
    sourcePolicy: z.enum(["official_required", "reviewed_primary", "manual"]),
    validFrom: z.iso.datetime({ offset: true }),
    validUntil: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((v, c) => {
    const expected = {
      official_lineup: "lineup_status",
      official_result: "event_final",
      source_correction: "source_revision",
      manual_review: "manual",
    };
    if (expected[v.kind] !== v.predicate.type)
      c.addIssue({ code: "custom", message: "Condition predicate mismatch" });
    if (Date.parse(v.validUntil) <= Date.parse(v.validFrom))
      c.addIssue({ code: "custom", message: "Invalid validity interval" });
    if (
      ["official_lineup", "official_result"].includes(v.kind) &&
      v.sourcePolicy !== "official_required"
    )
      c.addIssue({
        code: "custom",
        message: "Lineup requires official evidence",
      });
  });
export type ReasonCondition = z.infer<typeof reasonConditionSchema>;
export const confirmPickReasonSchema = z
  .object({
    requestId: id,
    basePickVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(4000),
    conditions: z.array(reasonConditionSchema).max(4),
    confirmed: z.literal(true),
    enableMonitoring: z.boolean(),
  })
  .strict();
export const reasonVersionSchema = z
  .object({
    id,
    ownerId: id,
    pickId: id,
    pickVersion: z.number().int().positive(),
    revision: z.number().int().positive(),
    userText: z.string().trim().min(1).max(4000),
    conditions: z.array(reasonConditionSchema).max(4),
    confirmedAt: z.iso.datetime({ offset: true }),
    evidenceRefs: z.array(id).max(100),
    mode: dataModeSchema,
  })
  .strict();
export type ReasonVersion = z.infer<typeof reasonVersionSchema>;
export type ConfirmPickReason = z.infer<typeof confirmPickReasonSchema>;
