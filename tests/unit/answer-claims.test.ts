import { expect, it } from "vitest";
import {
  answerWithContext,
  createAgentContext,
} from "../../packages/agent/src/context";
const context = createAgentContext({
  userId: "u",
  market: {
    platform: "kalshi",
    nativeId: "m",
    question: "Will A win?",
    outcomes: ["Yes", "No"],
    rules: "Official result",
  },
  pick: null,
  lessons: [],
  evidence: [],
  now: new Date("2026-11-03T00:00:00Z"),
});
const response = {
  message: "There is no current evidence.",
  evidenceRefs: [],
  lessonRefs: [],
  proposedChange: null,
};

it("keeps only exact, uniquely identified claim annotations in one generation", async () => {
  const valid = {
    claimId: "valid",
    claimText: response.message,
    evidenceIds: [],
  };
  const duplicate = { ...valid, claimId: "duplicate" };
  let calls = 0;
  await expect(
    answerWithContext(context, "Explain", async () => {
      calls++;
      return {
        ...response,
        answerClaims: [
          valid,
          duplicate,
          duplicate,
          { ...valid, claimId: "span", claimText: "A wins" },
          { ...valid, claimId: "foreign", evidenceIds: ["foreign"] },
        ],
      };
    }),
  ).resolves.toMatchObject({
    message: response.message,
    answerClaims: [valid],
  });
  expect(calls).toBe(1);
});

it("rejects a foreign top-level citation even if an invalid annotation is discarded", async () => {
  await expect(
    answerWithContext(context, "Explain", async () => ({
      ...response,
      evidenceRefs: ["foreign"],
      answerClaims: [
        { claimId: "c", claimText: "A wins", evidenceIds: ["foreign"] },
      ],
    })),
  ).rejects.toThrow("UNKNOWN_CITATION");
});
