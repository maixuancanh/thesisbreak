import { z } from "zod";
const item = z
  .object({
    logicalId: z.string().min(1),
    type: z.string().min(1),
    version: z.number().int().positive(),
    verified: z.boolean(),
    consented: z.boolean(),
    active: z.boolean(),
    evaluationOnly: z.boolean(),
    utility: z.enum(["unreviewed", "useful", "not_useful"]),
    semanticKey: z.string().min(1),
  })
  .strict();
/** Count semantic units, not blobs/versions or workflow-test artifacts. Utility requires explicit review. */
export function usefulMemoryInventory(input: unknown[]) {
  const rows = input.map((r) => item.parse(r));
  const latest = new Map<string, z.infer<typeof item>>();
  for (const r of rows) {
    const key = `${r.type}:${r.logicalId}`;
    const old = latest.get(key);
    if (!old || r.version > old.version) latest.set(key, r);
    else if (
      r.version === old.version &&
      JSON.stringify(r) !== JSON.stringify(old)
    )
      throw Error("CONFLICTING_INVENTORY_VERSION");
  }
  const knowledgeTypes = new Set([
    "lesson",
    "source_credibility",
    "conversation.session",
    "nba.forecast",
    "action.outcome",
  ]);
  const eligible = [...latest.values()].filter(
    (r) =>
      knowledgeTypes.has(r.type) &&
      r.verified &&
      r.consented &&
      r.active &&
      !r.evaluationOnly,
  );
  const useful = new Set(
    eligible
      .filter((r) => r.utility === "useful")
      .map((r) => `${r.type}:${r.semanticKey}`),
  );
  return {
    recordVersions: rows.length,
    distinctLogicalRecords: latest.size,
    eligibleDistinctRecords: eligible.length,
    reviewedUsefulDistinct: useful.size,
    unreviewedEligible: eligible.filter((r) => r.utility === "unreviewed")
      .length,
    evaluationRecordsExcluded: [...latest.values()].filter(
      (r) => r.evaluationOnly,
    ).length,
    meetsTenUsefulMemories: useful.size >= 10,
    verificationScope: "supplied_receipts_and_reviews" as const,
  };
}
