import { expect, it } from "vitest";
import { evaluateLearningPairs } from "../../packages/domain/src/learning-evaluation";
const attempt = {
  pairId: "p",
  fixtureId: "f",
  modelVersion: "m",
  promptVersion: "v",
  questionHash: "q",
  providerSnapshotHash: "s",
  arm: "with_memory" as const,
  expectedMemoryIds: ["right"],
  retrievedMemoryIds: ["wrong"],
  usedMemoryIds: ["wrong"],
  expectedRequiredTools: ["official"],
  policyRequiredTools: ["official"],
  modelSelectedTools: [],
  executedTools: [],
  invalidProposal: true,
  proposalBlocked: true,
  plannerTrace: ["planned"],
  toolTrace: ["failed"],
  latencyMs: 10,
  costUsd: 0.01,
  failure: "provider unavailable",
};
it("preserves failed attempts and denominators without inventing benefits", () => {
  const result = evaluateLearningPairs([
    attempt,
    { ...attempt, arm: "without_memory", failure: null },
  ]);
  expect(result.attempts).toHaveLength(2);
  expect(result.failedAttempts).toBe(1);
  expect(result.failedPairs).toBe(1);
  expect(result.completePairs).toBe(0);
  expect(result.recallAtK).toBe(0);
  expect(result.wrongMemoryUses).toBe(2);
  expect(result.requiredToolCompletion).toBe(0);
  expect(result.invalidProposalsBlocked).toBe(2);
  expect(result.confirmedGroundingImprovement).toBe(false);
});
it("rejects generation-only and mismatched snapshot comparisons", () => {
  expect(() =>
    evaluateLearningPairs([{ ...attempt, plannerTrace: [] }]),
  ).toThrow("ACTION_TRACE_REQUIRED");
  expect(() =>
    evaluateLearningPairs([
      attempt,
      { ...attempt, arm: "without_memory", providerSnapshotHash: "different" },
    ]),
  ).toThrow("UNMATCHED_PAIR");
});
it("keeps unavailable provider cost unknown rather than reporting zero", () => {
  const result = evaluateLearningPairs([{ ...attempt, costUsd: null }]);
  expect(result.totalCostUsd).toBeNull();
  expect(result.costMeasurementCoverage).toBe(0);
});
