import { z } from "zod";
const id = z.string().trim().min(1).max(300),
  rev = z.number().int().positive();
export const claimAnchorSchema = z
  .object({
    ownerId: id,
    sessionId: id,
    messageId: id,
    answerRevision: rev,
    claimId: id,
    claimTextHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ClaimAnchor = z.infer<typeof claimAnchorSchema>;
export const answerClaimSchema = claimAnchorSchema
  .extend({
    claimText: z.string().trim().min(1).max(4000),
    evidenceIds: z.array(id).max(100),
  })
  .strict();
export type AnswerClaim = z.infer<typeof answerClaimSchema>;
export const challengeStatusSchema = z.enum([
  "submitted",
  "checking",
  "needs_evidence",
  "accepted",
  "not_supported",
  "withdrawn",
]);
export type ChallengeStatus = z.infer<typeof challengeStatusSchema>;
export const submitClaimChallengeSchema = z
  .object({
    messageId: id,
    answerRevision: rev,
    claimId: id,
    explanation: z.string().trim().min(1).max(4000),
    evidenceUrls: z
      .array(
        z
          .url()
          .max(2000)
          .refine((v) => ["https:", "http:"].includes(new URL(v).protocol)),
      )
      .max(5),
    clientRequestId: id,
  })
  .strict();
export const withdrawClaimChallengeSchema = z
  .object({ action: z.literal("withdraw"), expectedRevision: rev })
  .strict();
export const claimChallengeRevisionSchema = z
  .object({
    challengeId: id,
    ownerId: id,
    revision: rev,
    status: challengeStatusSchema,
    explanation: z.string().max(4000),
    evidenceIds: z.array(id).max(100),
    correctionText: z.string().min(1).max(12000).nullable(),
    checkedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.status === "accepted" && (!v.evidenceIds.length || !v.correctionText))
      c.addIssue({
        code: "custom",
        message: "Accepted correction requires evidence and correction text",
      });
  });
export type ClaimChallengeRevision = z.infer<
  typeof claimChallengeRevisionSchema
>;
