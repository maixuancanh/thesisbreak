import { it, expect } from "vitest";
import {
  scoreResearchReply,
  researchCases,
} from "../../evals/research-quality";
it("does not score absent/invalid claims as passing or treat memory citation as quality", () => {
  const caseA = researchCases[0]!;
  const blank = {
    message: "Unknown",
    evidenceRefs: [],
    lessonRefs: [],
    proposedChange: null,
  };
  expect(scoreResearchReply(caseA, blank).reasonCorrect).toBe(false);
  const good = {
    ...blank,
    lessonRefs: ["lesson"],
    reasonReview: {
      baseVersion: 1,
      summary: "Unknown",
      claims: [
        {
          claim: caseA.reason,
          status: caseA.expected,
          explanation: "No official confirmation",
          evidenceRefs: [],
        },
      ],
    },
  };
  expect(scoreResearchReply(caseA, good)).toMatchObject({
    reasonCorrect: true,
    noMutation: true,
  });
  expect(
    scoreResearchReply(caseA, {
      ...good,
      reasonReview: { ...good.reasonReview, claims: [] },
    }).reasonCorrect,
  ).toBe(false);
  expect(
    scoreResearchReply(caseA, {
      ...good,
      proposedChange: { baseVersion: 1, outcome: "Yes", reason: null },
    }).noMutation,
  ).toBe(false);
});
