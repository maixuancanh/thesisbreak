import { expect, it } from "vitest";
import {
  buildForecastScorecard,
  type ForecastScorecardSample,
} from "../../packages/domain/src/forecast-scorecard";
const asOf = "2026-10-03T00:00:00Z";
const sample = (
  id: string,
  overrides: Partial<ForecastScorecardSample> = {},
): ForecastScorecardSample => ({
  eventId: id,
  horizon: "T24h",
  methodVersion: "elo-v1",
  recordedAt: "2026-10-01T00:00:00Z",
  scheduledAt: "2026-10-02T00:00:00Z",
  resolvedAt: "2026-10-02T03:00:00Z",
  availableAt: "2026-10-02T04:00:00Z",
  status: "final",
  homeWin: true,
  probability: 0.8,
  baselineProbability: 0.5,
  predictionStatus: "ok",
  ...overrides,
});
it("retains denominators for unresolved, abstained, failed and missing baselines", () => {
  const card = buildForecastScorecard(
    [
      sample("a"),
      sample("b", { probability: null, predictionStatus: "abstained" }),
      sample("c", { baselineProbability: null }),
      sample("d", { probability: null, predictionStatus: "failed" }),
      sample("e", {
        status: "pending",
        homeWin: null,
        resolvedAt: null,
        availableAt: null,
      }),
    ],
    asOf,
  );
  expect(card.counts).toMatchObject({
    capturedEvents: 5,
    settledEvents: 4,
    predictedEvents: 2,
    pairedEvents: 1,
    abstainedEvents: 1,
    failedEvents: 1,
    unresolvedEvents: 1,
    missingBaselines: 1,
    missingScheduledEvents: null,
  });
  expect(card.coverage).toEqual({ model: 0.5, paired: 0.25, denominator: 4 });
  expect(card.model.brier).toBeCloseTo(0.04);
  expect(card.baseline.brier).toBeCloseTo(0.25);
  expect(card.status).toBe("insufficient_settled_events");
  expect(card.improvementDemonstrated).toBe(false);
});
it("leaves empty reliability bins null and includes probability one in final bin", () => {
  const card = buildForecastScorecard(
    [
      sample("a", { probability: 1 }),
      sample("b", { probability: 0, homeWin: false }),
    ],
    asOf,
  );
  expect(card.reliability[9]).toMatchObject({
    count: 1,
    meanProbability: 1,
    observedRate: 1,
  });
  expect(card.reliability[4]).toMatchObject({
    count: 0,
    meanProbability: null,
    observedRate: null,
  });
  expect(card.model.ece).toBe(0);
  expect(Number.isFinite(card.model.logLoss)).toBe(true);
});
it("rejects nonfinite probabilities, inconsistent abstentions and time leakage", () => {
  expect(() =>
    buildForecastScorecard([sample("a", { probability: NaN })], asOf),
  ).toThrow();
  expect(() =>
    buildForecastScorecard([sample("a", { probability: null })], asOf),
  ).toThrow("INVALID_PREDICTION_STATUS");
  expect(() =>
    buildForecastScorecard(
      [sample("a", { recordedAt: "2026-10-02T00:00:00Z" })],
      asOf,
    ),
  ).toThrow("LATE_FORECAST");
  expect(() =>
    buildForecastScorecard(
      [sample("a", { availableAt: "2026-10-01T00:00:00Z" })],
      asOf,
    ),
  ).toThrow("INVALID_LABEL_TIMELINE");
});
it("does not score labels unavailable at the report time", () => {
  const card = buildForecastScorecard(
    [sample("a", { availableAt: "2026-10-04T00:00:00Z" })],
    asOf,
  );
  expect(card.counts.settledEvents).toBe(0);
  expect(card.counts.unavailableLabels).toBe(1);
  expect(card.model.brier).toBeNull();
  expect(card.coverage.model).toBeNull();
});
it("rejects duplicate events and aggregation across horizons or methods", () => {
  expect(() =>
    buildForecastScorecard([sample("a"), sample("a")], asOf),
  ).toThrow("DUPLICATE_EVENT");
  expect(() =>
    buildForecastScorecard(
      [sample("a"), sample("b", { horizon: "T60m" })],
      asOf,
    ),
  ).toThrow("MIXED_SCORECARD_COHORT");
  expect(() =>
    buildForecastScorecard(
      [sample("a"), sample("b", { methodVersion: "v2" })],
      asOf,
    ),
  ).toThrow("MIXED_SCORECARD_COHORT");
});
it("compares paired scores on the same events and retains deterministic descriptive interval", () => {
  const rows = [
    sample("a"),
    sample("b", { probability: 0.2, homeWin: false }),
    sample("c", { probability: 0.9, baselineProbability: null }),
  ];
  const card = buildForecastScorecard(rows, asOf);
  expect(card.paired.modelBrier).toBeCloseTo(0.04);
  expect(card.paired.baselineBrier).toBeCloseTo(0.25);
  expect(card.paired.brierDelta).toBeCloseTo(-0.21);
  expect(card.paired.interval).toEqual(
    buildForecastScorecard([...rows].reverse(), asOf).paired.interval,
  );
  expect(card.paired.interval?.method).toBe("event-bootstrap-percentile");
});
it("returns honest empty metrics", () => {
  const card = buildForecastScorecard([], asOf);
  expect(card.counts.capturedEvents).toBe(0);
  expect(card.paired.interval).toBeNull();
  expect(card.model.ece).toBeNull();
  expect(card.reliability).toHaveLength(10);
});
