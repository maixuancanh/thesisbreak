import { z } from "zod";
const refs = z.array(z.string().min(1).max(256)).max(10);
export const reasonReviewSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    summary: z.string().min(1).max(1500),
    claims: z
      .array(
        z
          .object({
            claim: z.string().min(1).max(600),
            status: z.enum(["supported", "contradicted", "unclear"]),
            explanation: z.string().min(1).max(1200),
            evidenceRefs: refs,
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();
export const retrospectiveSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    summary: z.string().min(1).max(2000),
    reasoningLesson: z.string().min(1).max(2000).nullable(),
    evidenceRefs: refs,
  })
  .strict();
export const settlementSchema = z
  .object({
    outcome: z.string().min(1).max(256),
    resolvedAt: z.iso.datetime({ offset: true }),
    pickRecordedAt: z.iso.datetime({ offset: true }),
    sourceRef: z.string().min(1).max(256),
  })
  .strict();
export const outcomeReviewSchema = settlementSchema.extend({
  baseVersion: z.number().int().positive(),
  pickedOutcome: z.string(),
  comparison: z.enum(["matched", "did_not_match", "not_scored"]),
});
export function settlementComparison(
  outcome: string,
  settlement: z.infer<typeof settlementSchema>,
) {
  return Date.parse(settlement.pickRecordedAt) >=
    Date.parse(settlement.resolvedAt)
    ? "not_scored"
    : outcome === settlement.outcome
      ? "matched"
      : "did_not_match";
}
