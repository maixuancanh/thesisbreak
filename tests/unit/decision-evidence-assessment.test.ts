import { describe, expect, it } from "vitest";
import {
  assessDecisionEvidence,
  selectDecisionQuoteSnapshots,
} from "../../packages/agent/src/decision-evidence-assessment";
const now = "2026-11-03T12:00:00.000Z";
const quote = (probability: number, observedAt: string) => ({
  id: observedAt,
  provider: "synthetic",
  marketId: "market",
  outcomeId: "yes",
  rulesHash: "a".repeat(64),
  quoteType: "mid" as const,
  probability,
  observedAt,
  spread: 0.02,
  status: "open" as const,
  liquidityAvailable: true,
});
const before = quote(0.4, "2026-11-03T11:59:00.000Z");
const after = quote(0.6, now);
describe("decision evidence assessment", () => {
  const challenger = {
    version: "synthetic-calibration-v1",
    cutoff: "2026-11-03T11:00:00.000Z",
    baselineAt: now,
    consented: true,
    currentEligible: true,
    baselineProbability: 0.5,
    probability: 0.6,
    evaluation: {
      heldoutAfterTraining: true,
      pairedEvents: 500,
      pairedCoverage: 1,
      improvementInterval: { lower: 0.01, upper: 0.03 },
      pairedModelLogLoss: 0.5,
      pairedBaselineLogLoss: 0.6,
    },
  };
  it.each([
    { consented: false },
    { currentEligible: false },
    { cutoff: "2026-11-03T12:00:01.000Z" },
    { baselineAt: "2026-11-03T11:59:00.000Z" },
  ])("does not treat ineligible challenger as validated: %j", (patch) => {
    expect(
      assessDecisionEvidence({
        reasonImpact: "invalidated",
        beforeQuote: null,
        afterQuote: null,
        observedAt: now,
        challenger: { ...challenger, ...patch },
      }),
    ).toMatchObject({
      adjustmentStatus: "insufficient_evidence",
      adjustedProbability: null,
      needsReview: true,
    });
  });
  it("retains qualified research as a challenger without promoting a forecast", () => {
    expect(
      assessDecisionEvidence({
        reasonImpact: "invalidated",
        beforeQuote: null,
        afterQuote: null,
        observedAt: now,
        challenger,
      }),
    ).toMatchObject({
      adjustmentStatus: "validated_challenger",
      adjustedProbability: null,
      needsReview: true,
    });
  });
  it.each([
    { heldoutAfterTraining: false },
    { pairedEvents: 499 },
    { pairedCoverage: 0.8 },
    { improvementInterval: { lower: -0.01, upper: 0.03 } },
    { pairedModelLogLoss: 0.7 },
  ])(
    "reuses chronological calibration gates for an unvalidated candidate: %j",
    (patch) => {
      expect(
        assessDecisionEvidence({
          reasonImpact: "invalidated",
          beforeQuote: null,
          afterQuote: null,
          observedAt: now,
          challenger: {
            ...challenger,
            evaluation: { ...challenger.evaluation, ...patch },
          },
        }).adjustmentStatus,
      ).toBe("candidate_only");
    },
  );
  it("never fabricates a before snapshot from an after-only record", () => {
    expect(
      selectDecisionQuoteSnapshots({
        quotes: [after],
        triggerObservedAt: "2026-11-03T11:59:30.000Z",
        now,
      }),
    ).toEqual({ beforeQuote: null, afterQuote: after });
  });
  it("does not select future snapshots or stale after evidence", () => {
    expect(
      selectDecisionQuoteSnapshots({
        quotes: [before, { ...after, observedAt: "2026-11-03T12:00:01.000Z" }],
        triggerObservedAt: "2026-11-03T11:59:30.000Z",
        now,
      }),
    ).toEqual({ beforeQuote: before, afterQuote: null });
  });
  it("keeps a contradicted reason review independent of missing price data", () => {
    expect(
      assessDecisionEvidence({
        reasonImpact: "invalidated",
        beforeQuote: null,
        afterQuote: null,
        challenger: null,
      }),
    ).toMatchObject({
      needsReview: true,
      priceAssessment: "unknown",
      adjustmentStatus: "insufficient_evidence",
      adjustedProbability: null,
    });
  });
  it("reports observed movement without causal or probability inference", () => {
    expect(
      assessDecisionEvidence({
        reasonImpact: "invalidated",
        beforeQuote: before,
        afterQuote: after,
        observedAt: now,
      }),
    ).toMatchObject({
      needsReview: true,
      priceAssessment: "movement_observed",
      adjustedProbability: null,
      adjustmentStatus: "insufficient_evidence",
    });
  });
  it.each([
    { ...after, quoteType: "last_trade" },
    { ...after, outcomeId: "no" },
    { ...after, marketId: "different" },
    { ...after, rulesHash: "b".repeat(64) },
    { ...after, provider: "other" },
    { ...after, status: "suspended" },
    { ...after, liquidityAvailable: false },
    { ...after, observedAt: "2026-11-03T12:01:00.000Z" },
    { ...after, observedAt: "2026-11-03T10:00:00.000Z" },
  ])(
    "abstains for noncomparable, stale, unavailable or future quotes: %j",
    (bad) => {
      expect(
        assessDecisionEvidence({
          reasonImpact: "weakened",
          beforeQuote: before,
          afterQuote: bad,
          observedAt: now,
        }).priceAssessment,
      ).toBe("unknown");
    },
  );
  it("does not accept a raw model probability", () => {
    expect(() =>
      assessDecisionEvidence({
        reasonImpact: "unknown",
        beforeQuote: null,
        afterQuote: null,
        challenger: { probability: 0.8 },
      }),
    ).toThrow();
  });
});
