import { expect, it } from "vitest";
import { saveDecisionEvidenceAssessment } from "../../packages/db/src/decision-evidence-assessments";
it("rejects forged assessment payload before obtaining a database connection", async () => {
  const pool = {
    connect: () => {
      throw Error("SHOULD_NOT_CONNECT");
    },
  };
  await expect(
    saveDecisionEvidenceAssessment(pool as never, "owner", {
      caseId: "case",
      caseRevision: 1,
      pickId: "pick",
      pickVersion: 1,
      reasonId: "reason",
      reasonVersion: 1,
      assessment: {
        reasonImpact: "invalidated",
        priceAssessment: "unknown",
        adjustmentStatus: "insufficient_evidence",
        needsReview: false,
        adjustedProbability: 0.9,
        evidenceIds: [],
        configVersion: "v1",
        checkedAt: new Date().toISOString(),
      },
    }),
  ).rejects.not.toThrow("SHOULD_NOT_CONNECT");
});
