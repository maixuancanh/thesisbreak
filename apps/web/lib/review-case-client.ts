import { z } from "zod";
import { reviewCaseSchema } from "../../../packages/domain/src/review-case";
import { decisionEvidenceAssessmentSchema } from "../../../packages/domain/src/decision-evidence-assessment";
export const reviewCasesResponse = z.object({
  items: z.array(reviewCaseSchema),
  nextCursor: z.string().nullable(),
  assessments: z.array(
    z.object({
      caseId: z.string(),
      items: z.array(
        z.object({
          id: z.string(),
          pickId: z.string(),
          pickVersion: z.number().int().positive(),
          reasonId: z.string(),
          reasonVersion: z.number().int().positive(),
          assessment: decisionEvidenceAssessmentSchema,
        }),
      ),
    }),
  ),
});
export const followupSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  caseRevision: z.number().int().positive(),
  pickId: z.string(),
  reasonId: z.string(),
  state: z.enum(["pending", "snoozed"]),
  dueAt: z.string().nullable(),
});
export const followupsResponse = z.object({ items: z.array(followupSchema) });
export type ReviewFollowup = z.infer<typeof followupSchema>;
