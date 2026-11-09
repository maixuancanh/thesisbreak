import { z } from "zod";
const id = z.string().trim().min(1).max(300);
export const observedDecisionQuoteSchema = z
  .object({
    id,
    provider: id,
    marketId: id,
    outcomeId: id,
    rulesHash: z.string().regex(/^[a-f0-9]{64}$/),
    quoteType: z.enum(["mid", "last_trade", "bid", "ask"]),
    probability: z.number().finite().min(0).max(1),
    observedAt: z.iso.datetime({ offset: true }),
    spread: z.number().finite().min(0).max(1).nullable(),
    status: z.enum(["open", "suspended", "closed"]),
    liquidityAvailable: z.boolean(),
  })
  .strict();
export const reasonImpactSchema = z.enum([
  "unchanged",
  "weakened",
  "invalidated",
  "unknown",
]);
export const priceAssessmentSchema = z.enum([
  "movement_observed",
  "no_observed_movement",
  "unknown",
]);
export const adjustmentStatusSchema = z.enum([
  "not_assessed",
  "insufficient_evidence",
  "candidate_only",
  "validated_challenger",
]);
export type ReasonImpact = z.infer<typeof reasonImpactSchema>;
export type PriceAssessment = z.infer<typeof priceAssessmentSchema>;
export type AdjustmentStatus = z.infer<typeof adjustmentStatusSchema>;
export const decisionEvidenceAssessmentSchema = z
  .object({
    reasonImpact: reasonImpactSchema,
    priceAssessment: priceAssessmentSchema,
    adjustmentStatus: adjustmentStatusSchema,
    needsReview: z.boolean(),
    adjustedProbability: z.number().min(0).max(1).nullable(),
    evidenceIds: z.array(id).max(100),
    configVersion: id,
    checkedAt: z.iso.datetime({ offset: true }),
    quoteContext: z
      .object({
        before: observedDecisionQuoteSchema.nullable(),
        after: observedDecisionQuoteSchema.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.adjustedProbability !== null &&
      v.adjustmentStatus !== "validated_challenger"
    )
      c.addIssue({
        code: "custom",
        message: "Probability requires validated challenger",
      });
    if (["invalidated", "weakened"].includes(v.reasonImpact) && !v.needsReview)
      c.addIssue({
        code: "custom",
        message: "Reason impact must remain reviewable",
      });
  });
export type DecisionEvidenceAssessment = z.infer<
  typeof decisionEvidenceAssessmentSchema
>;
