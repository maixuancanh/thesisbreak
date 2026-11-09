import { z } from "zod";
export const planningArtifactSchema = z
  .object({
    logicalId: z.string(),
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    blobId: z.string().min(1),
    check: z.enum([
      "recheck_changed_source_dependency",
      "compare_original_forecast_evidence",
      "check_official_result_revision",
      "inspect_drift_before_using_calibration",
      "compare_reason_condition_and_official_result",
      "recheck_disputed_claim_dependencies",
    ]),
    causalBenefit: z.literal("not_measured"),
  })
  .strict();
export function researchArtifactTools(raw: unknown[]) {
  const artifacts = raw.slice(0, 4).map((r) => planningArtifactSchema.parse(r));
  const tools = new Set<"compare_snapshot" | "read_independent_sources">();
  for (const a of artifacts) {
    tools.add("compare_snapshot");
    if (
      a.check === "recheck_changed_source_dependency" ||
      a.check === "check_official_result_revision" ||
      a.check === "compare_reason_condition_and_official_result" ||
      a.check === "recheck_disputed_claim_dependencies"
    )
      tools.add("read_independent_sources");
  }
  return { artifacts, requiredTools: [...tools] };
}
