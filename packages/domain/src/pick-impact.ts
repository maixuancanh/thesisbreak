import { z } from "zod";
export const reviewStateSchema = z.enum([
  "needs_review",
  "waiting_confirmation",
  "check_unavailable",
  "still_watching",
]);
export type ReviewState = z.infer<typeof reviewStateSchema>;
export const impactAssessmentSchema = z
  .object({
    id: z.string(),
    changeId: z.string(),
    pickId: z.string(),
    pickVersion: z.number().int().positive(),
    reasonId: z.string(),
    reasonRevision: z.number().int().positive(),
    state: reviewStateSchema,
    evidenceState: z.enum(["supported", "contradicted", "unclear"]),
    conditionMet: z.boolean().nullable(),
    beforeRefs: z.array(z.string()),
    afterRefs: z.array(z.string()),
    explanation: z.string().max(4000),
    checkedAt: z.string(),
    rulesVersion: z.string(),
    modelVersion: z.string().nullable(),
  })
  .strict();
export type ImpactAssessment = z.infer<typeof impactAssessmentSchema>;
export function classifyPickImpact(v: {
  sourceAvailable: boolean;
  inScope: boolean;
  officialRequired: boolean;
  officialConfirmed: boolean;
  materialContradiction: boolean | null;
  conditionMet: boolean | null;
}): ReviewState {
  if (!v.inScope) return "still_watching";
  if (!v.sourceAvailable) return "check_unavailable";
  if (v.officialRequired && !v.officialConfirmed) return "waiting_confirmation";
  if (v.conditionMet === true || v.materialContradiction === true)
    return "needs_review";
  if (v.conditionMet === null || v.materialContradiction === null)
    return "waiting_confirmation";
  return "still_watching";
}
