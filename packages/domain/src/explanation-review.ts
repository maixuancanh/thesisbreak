import { z } from "zod";
const id = z.string().trim().min(1).max(300),
  rev = z.number().int().positive();
export const explanationStatusSchema = z.enum([
  "not_assessed",
  "supported",
  "under_review",
  "corrected",
  "inconclusive",
]);
export type ExplanationStatus = z.infer<typeof explanationStatusSchema>;
export const explanationReviewSchema = z
  .object({
    id,
    ownerId: id,
    pickId: id,
    recapId: id,
    revision: rev,
    status: explanationStatusSchema,
    dependencyRefs: z.array(z.object({ id, revision: rev }).strict()).max(100),
    evidenceIds: z.array(id).max(100),
    challengeIds: z.array(id).max(100),
    summary: z.string().max(4000),
    supersedesId: id.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ExplanationReview = z.infer<typeof explanationReviewSchema>;
export const explanationReferenceSchema = z
  .object({ id, revision: rev, status: explanationStatusSchema })
  .strict();
