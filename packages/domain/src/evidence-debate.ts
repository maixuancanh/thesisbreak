import { z } from "zod";
const id = z.string().min(1).max(300);
const text = z.string().min(1).max(3000);
export const debateSnapshotSchema = z
  .object({
    id,
    originId: id,
    eventId: id,
    availableAt: z.iso.datetime({ offset: true }),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().min(1).max(16000),
  })
  .strict();
export const debateSideSchema = z
  .object({
    claims: z
      .array(
        z
          .object({
            text,
            evidenceIds: z.array(id).min(1).max(30),
            assumption: text,
            falsifier: text,
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const debateDispositionSchema = z
  .object({
    disposition: z.enum(["keep", "review", "insufficient_evidence"]),
    strongestObjection: z
      .object({
        dissentId: id,
        explanation: text,
        evidenceIds: z.array(id).min(1).max(30),
      })
      .strict()
      .nullable()
      .optional(),
    supportingIds: z.array(id).max(100),
    opposingIds: z.array(id).max(100),
    missingChecks: z.array(id).max(100),
    explanation: text,
  })
  .strict();
export const debateInputSchema = z
  .object({
    trigger: z
      .enum([
        "explicit_challenge",
        "verified_source_disagreement",
        "approved_countercheck_policy",
      ])
      .nullable(),
    eventId: id,
    cutoffAt: z.iso.datetime({ offset: true }),
    evidence: z.array(debateSnapshotSchema).max(100),
    requiredChecks: z.array(id).max(100),
    completedChecks: z.array(id).max(100),
    remainingCalls: z.number().int().min(0).max(100),
    maxOutputTokens: z.number().int().min(3).max(12000),
    timeoutMs: z.number().int().min(1).max(60000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      new Set(v.evidence.map((e) => e.id)).size !== v.evidence.length ||
      v.evidence.some(
        (e) =>
          e.eventId !== v.eventId ||
          Date.parse(e.availableAt) > Date.parse(v.cutoffAt),
      )
    )
      ctx.addIssue({ code: "custom", message: "INVALID_FROZEN_EVIDENCE" });
  });
export type DebateInput = z.infer<typeof debateInputSchema>;
export type DebateSide = z.infer<typeof debateSideSchema>;
export type DebateDisposition = z.infer<typeof debateDispositionSchema>;
