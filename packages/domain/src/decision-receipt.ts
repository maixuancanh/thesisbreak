import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const memory = z
  .object({ id: z.string().min(1), version: z.number().int().positive(), hash })
  .strict();
const tool = z
  .object({
    name: z.string().min(1),
    status: z.enum(["succeeded", "failed", "unavailable"]),
    observedAt: z.iso.datetime().nullable(),
    resultHash: hash.nullable(),
    startedAt: z.iso.datetime().nullable().optional(),
    completedAt: z.iso.datetime().nullable().optional(),
    observationKind: z
      .enum(["provider_timestamp", "retrieval_timestamp"])
      .nullable()
      .optional(),
  })
  .strict();
export const decisionReceiptSchema = z
  .object({
    id: z.string().min(1),
    ownerId: z.string().min(1),
    eventId: z.string().min(1),
    modelVersion: z.string().min(1),
    promptVersion: z.string().min(1),
    memories: z.array(memory).max(50),
    appliedConditions: z.array(z.string().max(256)).max(30),
    requiredTools: z.array(z.string().max(128)).max(30),
    selectedTools: z.array(z.string().max(128)).max(30),
    executedTools: z.array(tool).max(50),
    evidence: z
      .array(
        z
          .object({
            id: z.string().min(1),
            version: z.number().int().positive(),
            hash,
            observedAt: z.iso.datetime().nullable(),
          })
          .strict(),
      )
      .max(100),
    blockedProposal: z
      .object({ code: z.string().max(128) })
      .strict()
      .optional(),
    userDecision: z.enum(["confirmed", "rejected", "pending"]).optional(),
    proposalId: z.string().min(1).optional(),
    sourceReceipt: z
      .object({ id: z.string().min(1), hash })
      .strict()
      .optional(),
    publication: z.enum([
      "not_requested",
      "pending",
      "published",
      "verified",
      "failed",
    ]),
    recordedAt: z.iso.datetime(),
  })
  .strict();
export type DecisionReceipt = z.infer<typeof decisionReceiptSchema>;
/** Public exports contain only proof identifiers and bounded typed metadata; never arbitrary trace text. */
export function publicDecisionReceipt(input: unknown) {
  const r = decisionReceiptSchema.parse(input);
  return {
    id: r.id,
    eventId: r.eventId,
    modelVersion: r.modelVersion,
    promptVersion: r.promptVersion,
    memories: r.memories,
    appliedConditions: r.appliedConditions,
    requiredTools: r.requiredTools,
    selectedTools: r.selectedTools,
    executedTools: r.executedTools.map((t) => {
      const exported: Record<string, string | null> = {
        name: t.name,
        status: t.status,
        observedAt: t.observedAt,
        resultHash: t.resultHash,
      };
      // Preserve legacy remote bytes: absent metadata is not retroactively appended as null.
      if (t.startedAt !== undefined) exported.startedAt = t.startedAt;
      if (t.completedAt !== undefined) exported.completedAt = t.completedAt;
      if (t.observationKind !== undefined)
        exported.observationKind = t.observationKind;
      return exported;
    }),
    evidence: r.evidence,
    blockedProposal: r.blockedProposal ?? null,
    userDecision: r.userDecision ?? null,
    ...(r.proposalId ? { proposalId: r.proposalId } : {}),
    ...(r.sourceReceipt ? { sourceReceipt: r.sourceReceipt } : {}),
    publication: r.publication,
    recordedAt: r.recordedAt,
  };
}
type RecordProof =
  | { capability: "unsupported" | "account_checkpoint" }
  | {
      capability: "exact_record";
      recordId: string;
      hash: string;
      transactionId: string;
      checkpoint: string;
      includedAt: string;
    };
/** Only an adapter that actually verifies exact-record SDK evidence may supply exact_record. */
export function assessRecordBinding(
  input: { expectedHash: string; expectedRecordId: string; cutoff: string },
  proof: RecordProof | null,
) {
  if (!proof) return { status: "unavailable" as const };
  if (proof.capability !== "exact_record")
    return { status: "unsupported" as const };
  if (
    !hash.safeParse(input.expectedHash).success ||
    proof.hash !== input.expectedHash ||
    proof.recordId !== input.expectedRecordId ||
    !proof.transactionId ||
    !proof.checkpoint
  )
    return { status: "mismatch" as const };
  const included = Date.parse(proof.includedAt),
    cutoff = Date.parse(input.cutoff);
  if (!Number.isFinite(included) || !Number.isFinite(cutoff))
    return { status: "unavailable" as const };
  return {
    status:
      included > cutoff ? ("post_cutoff" as const) : ("verified" as const),
  };
}
