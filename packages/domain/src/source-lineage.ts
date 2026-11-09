import { z } from "zod";
export const lineageEdgeSchema = z
  .object({
    id: z.string().min(1),
    fromEvidenceId: z.string().min(1),
    toEvidenceId: z.string().min(1),
    relation: z.enum(["explicit_citation", "syndicated_copy", "correction_of"]),
    verification: z.enum(["verified", "candidate"]),
    supportRef: z.string().min(1).max(2000),
    supportHash: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.number().int().positive(),
  })
  .strict()
  .refine((v) => v.fromEvidenceId !== v.toEvidenceId, "Self edge");
export type LineageEdge = z.infer<typeof lineageEdgeSchema>;
