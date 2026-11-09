import { z } from "zod";
import { reviewDissentSchema } from "../../domain/src/review-case";
const id = z.string().min(1).max(300);
const inputSchema = z
  .object({
    supportingEvidenceIds: z.array(id).max(100),
    opposingEvidenceIds: z.array(id).max(100),
    missingChecks: z.array(z.string().min(1).max(1000)).max(30),
    dissent: z.array(reviewDissentSchema).max(30),
    strongestObjectionId: id.nullable(),
  })
  .strict();
/** Frozen evidence identities only. No votes, inferred probabilities or source instructions. */
export function summarizeReviewCase(
  raw: unknown,
  allowedEvidenceIds: ReadonlySet<string>,
) {
  const v = inputSchema.parse(raw);
  for (const ref of [
    ...v.supportingEvidenceIds,
    ...v.opposingEvidenceIds,
    ...v.dissent.flatMap((d) => d.evidenceIds),
  ])
    if (!allowedEvidenceIds.has(ref)) throw Error("UNFROZEN_EVIDENCE");
  const objection = v.dissent.find((d) => d.id === v.strongestObjectionId);
  if (v.strongestObjectionId && !objection) throw Error("MISSING_DISSENT");
  return {
    ...v,
    summary: objection
      ? `Another check is needed. Strongest objection: ${objection.statement}`
      : "Another check is needed. Counterevidence has not been fully assessed.",
    missingChecks: v.dissent.length
      ? v.missingChecks
      : [...new Set([...v.missingChecks, "Dissent has not been assessed"])],
  };
}
