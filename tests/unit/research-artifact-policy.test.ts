import { it, expect } from "vitest";
import { researchArtifactTools } from "../../packages/agent/src/research-artifact-policy";
const a = {
  logicalId: "a",
  version: 1,
  hash: "a".repeat(64),
  blobId: "blob",
  causalBenefit: "not_measured",
};
it("verified source change requires real current independent read and comparison", () =>
  expect(
    researchArtifactTools([
      { ...a, check: "recheck_changed_source_dependency" },
    ]).requiredTools,
  ).toEqual(["compare_snapshot", "read_independent_sources"]));
it("drift memory adds inspection without silently changing calibration", () =>
  expect(
    researchArtifactTools([
      { ...a, check: "inspect_drift_before_using_calibration" },
    ]).requiredTools,
  ).toEqual(["compare_snapshot"]));
it("cannot inject arbitrary tools through artifact checks", () =>
  expect(() => researchArtifactTools([{ ...a, check: "trade" }])).toThrow());
