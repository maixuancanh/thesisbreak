import { it, expect } from "vitest";
import { summarizeReviewCase } from "../../packages/agent/src/review-case-summary";
it("preserves uncertainty when dissent is not assessed", () => {
  const r = summarizeReviewCase(
    {
      supportingEvidenceIds: ["e"],
      opposingEvidenceIds: [],
      missingChecks: [],
      dissent: [],
      strongestObjectionId: null,
    },
    new Set(["e"]),
  );
  expect(r.summary).toContain("not been fully assessed");
  expect(r.missingChecks).toContain("Dissent has not been assessed");
});
it("requires frozen citations and references the preserved strongest objection", () => {
  const v = {
    supportingEvidenceIds: [],
    opposingEvidenceIds: ["e"],
    missingChecks: [],
    dissent: [
      {
        id: "d",
        statement: "Official source disagrees",
        status: "opposing",
        evidenceIds: ["e"],
      },
    ],
    strongestObjectionId: "d",
  };
  expect(summarizeReviewCase(v, new Set(["e"])).summary).toContain(
    "Official source disagrees",
  );
  expect(() => summarizeReviewCase(v, new Set())).toThrow("UNFROZEN_EVIDENCE");
  expect(() =>
    summarizeReviewCase(
      { ...v, strongestObjectionId: "missing" },
      new Set(["e"]),
    ),
  ).toThrow("MISSING_DISSENT");
});
