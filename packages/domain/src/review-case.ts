import { z } from "zod";
const id = z.string().trim().min(1).max(300),
  rev = z.number().int().positive();
export const reviewCaseKeySchema = z
  .object({
    ownerId: id,
    eventId: id,
    triggerEvidenceRevisionId: id,
    reasonDependencyId: id,
  })
  .strict();
export type ReviewCaseKey = z.infer<typeof reviewCaseKeySchema>;
export const reviewDissentSchema = z
  .object({
    id,
    statement: z.string().trim().min(1).max(4000),
    assumption: z.string().min(1).max(3000).optional(),
    falsifier: z.string().min(1).max(3000).optional(),
    status: z.enum(["supported", "opposing", "unknown"]),
    evidenceIds: z.array(id).max(100),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.status !== "unknown" && !v.evidenceIds.length)
      c.addIssue({
        code: "custom",
        message: "Dissent requires evidence or unknown label",
      });
  });
export const reviewCasePickSchema = z
  .object({
    pickId: id,
    pickVersion: rev,
    reasonId: id,
    reasonVersion: rev,
    disposition: z.enum(["pending", "kept", "updated", "stopped"]),
    assessmentId: id.nullable(),
  })
  .strict();
export const reviewCaseSchema = reviewCaseKeySchema
  .extend({
    id,
    revision: rev,
    summary: z.string().max(4000).nullable(),
    supportingEvidenceIds: z.array(id).max(100),
    opposingEvidenceIds: z.array(id).max(100),
    missingChecks: z.array(z.string().min(1).max(1000)).max(30),
    dissent: z.array(reviewDissentSchema).max(30),
    strongestObjectionId: id.nullable(),
    strongestObjectionExplanation: z.string().min(1).max(3000).optional(),
    debateProof: z
      .object({
        runId: id,
        evidence: z
          .array(
            z
              .object({
                id,
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                retrievedAt: z.iso.datetime({ offset: true }),
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .optional(),
    picks: z.array(reviewCasePickSchema).max(100),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.strongestObjectionId &&
      !v.dissent.some((d) => d.id === v.strongestObjectionId)
    )
      c.addIssue({
        code: "custom",
        message: "Strongest objection must reference preserved dissent",
      });
  });
export type ReviewCase = z.infer<typeof reviewCaseSchema>;
export type ReviewCasePick = z.infer<typeof reviewCasePickSchema>;
