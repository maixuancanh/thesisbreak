import { z } from "zod";
import { assumptionSchema } from "./pick";
export const changeProposalSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    pickId: z.string().min(1),
    baseVersion: z.number().int().positive(),
    changes: z
      .object({
        outcome: z.string().min(1).optional(),
        reason: z.string().optional(),
        assumptions: z.array(assumptionSchema).optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0, "EMPTY_CHANGES"),
    reason: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
    expiresAt: z.iso.datetime(),
    status: z.enum(["pending", "accepted", "rejected"]),
  })
  .strict();
export class DomainConflict extends Error {
  readonly status = 409;
}
export function validateProposalAcceptance(
  input: unknown,
  c: { userId: string; pickId: string; currentVersion: number; now: Date },
) {
  const p = changeProposalSchema.parse(input);
  if (p.userId !== c.userId || p.pickId !== c.pickId)
    throw new Error("FORBIDDEN");
  if (p.status !== "pending") throw new DomainConflict("PROPOSAL_NOT_PENDING");
  if (new Date(p.expiresAt) <= c.now)
    throw new DomainConflict("PROPOSAL_EXPIRED");
  if (p.baseVersion !== c.currentVersion)
    throw new DomainConflict("VERSION_CONFLICT");
  return p;
}
