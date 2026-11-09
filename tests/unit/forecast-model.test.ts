import { describe, it, expect } from "vitest";
import {
  eloHomeProbability,
  ratingsBefore,
  devigDecimalOdds,
  fitTemporalTemperature,
  evaluateChronological,
  shadowPromotion,
  temperatureProbability,
  type EvaluationSample,
  type EloGame,
} from "../../packages/domain/src/forecast-model";
const row = (
  id: string,
  changes: Partial<EvaluationSample> = {},
): EvaluationSample => ({
  eventId: id,
  recordedAt: "2026-01-01T10:00:00Z",
  scheduledAt: "2026-01-01T11:00:00Z",
  resolvedAt: "2026-01-01T14:00:00Z",
  status: "final",
  homeWin: true,
  probability: 0.8,
  baselineProbability: 0.6,
  ...changes,
});
const game: EloGame = {
  eventId: "a",
  homeTeam: "A",
  awayTeam: "B",
  scheduledAt: "2026-01-01T11:00:00Z",
  resolvedAt: "2026-01-01T14:00:00Z",
  status: "final",
  homeScore: 110,
  awayScore: 100,
  homeRestDays: 1,
  awayRestDays: 1,
};
describe("auditable Elo", () => {
  it("is symmetric on neutral ground, configurable home/rest, and rejects invalid input", () => {
    const input = {
      homeRating: 1500,
      awayRating: 1500,
      homeRestDays: 3,
      awayRestDays: 1,
    };
    expect(eloHomeProbability({ ...input, neutral: true })).toBe(0.5);
    expect(eloHomeProbability(input)).toBeGreaterThan(0.5);
    expect(
      eloHomeProbability(input, { homeAdvantage: 0, restPointsPerDay: 10 }),
    ).toBeCloseTo(1 / (1 + 10 ** (-20 / 400)));
    expect(() => eloHomeProbability({ ...input, homeRating: NaN })).toThrow();
  });
  it("updates only known final prior games and conserves ratings", () => {
    expect(ratingsBefore([game], game.resolvedAt!).usedEventIds).toEqual([]);
    const result = ratingsBefore(
      [game, { ...game, eventId: "pending", status: "pending" }],
      "2026-01-02T00:00:00Z",
    );
    expect(result.usedEventIds).toEqual(["a"]);
    expect(result.ratings.A!).toBeGreaterThan(1500);
    expect(result.ratings.A! + result.ratings.B!).toBeCloseTo(3000);
    expect(() => ratingsBefore([game, game], "2026-01-02T00:00:00Z")).toThrow(
      "DUPLICATE_EVENT",
    );
    expect(() =>
      ratingsBefore([{ ...game, homeScore: 100 }], "2026-01-02T00:00:00Z"),
    ).toThrow("INVALID_FINAL_RESULT");
  });
  it("removes two-way bookmaker margin without treating odds as win certainty", () => {
    expect(devigDecimalOdds(1.8, 1.8)).toMatchObject({
      homeProbability: 0.5,
      awayProbability: 0.5,
    });
    expect(devigDecimalOdds(1.8, 1.8).overround).toBeGreaterThan(0);
    expect(() => devigDecimalOdds(1, 2)).toThrow();
  });
});
describe("temporal calibration and evaluation", () => {
  it("fits training only, softens overconfidence, prevents label and event leakage", () => {
    const train = Array.from({ length: 20 }, (_, i) =>
      row(`train-${i}`, { homeWin: i % 2 === 0 }),
    );
    const fitted = fitTemporalTemperature(train, "2026-02-01T00:00:00Z");
    expect(fitted.temperature).toBeGreaterThan(1);
    expect(temperatureProbability(0.8, fitted.temperature)).toBeLessThan(0.8);
    expect(() => fitTemporalTemperature(train, "2026-01-01T12:00:00Z")).toThrow(
      "TEMPORAL_LEAKAGE",
    );
    expect(() =>
      evaluateChronological(
        [
          row("train-0", {
            recordedAt: "2026-02-02T10:00:00Z",
            scheduledAt: "2026-02-02T11:00:00Z",
            resolvedAt: "2026-02-02T14:00:00Z",
          }),
        ],
        fitted,
      ),
    ).toThrow("HELDOUT_OVERLAP");
  });
  it("uses paired scores, independent coverage denominators, calibration bins and chronological events", () => {
    const result = evaluateChronological([
      row("unpaired", { baselineProbability: null }),
      row("missing", { probability: null }),
      row("paired"),
      row("late", { recordedAt: "2026-01-01T11:00:00Z" }),
    ]);
    expect(result).toMatchObject({
      events: 4,
      eligibleEvents: 3,
      predictedEvents: 2,
      pairedEvents: 1,
      coverage: 2 / 3,
      pairedCoverage: 1 / 3,
    });
    expect(result.brier).toBeCloseTo(0.04);
    expect(result.pairedBaselineBrier).toBeCloseTo(0.16);
    expect(result.pairedBrierImprovement).toBeCloseTo(0.12);
    expect(result.calibration[8]).toMatchObject({
      count: 2,
      meanProbability: 0.8,
      observedRate: 1,
    });
    expect(result.improvementInterval!.lower).toBeLessThan(0);
    expect(() => evaluateChronological([row("same"), row("same")])).toThrow(
      "DUPLICATE_EVENT",
    );
  });
  it("handles endpoints and empty cohorts without NaN or spurious promotion", () => {
    expect(
      evaluateChronological([row("wrong", { probability: 0 })]).logLoss,
    ).toBeGreaterThan(20);
    const result = evaluateChronological([]);
    expect(result.brier).toBeNull();
    expect(shadowPromotion(result)).toMatchObject({
      status: "remain_shadow",
      predictiveClaim: false,
      automaticPromotion: false,
    });
  });
  it("allows only a review candidate after conservative heldout evidence", () => {
    const fitted = fitTemporalTemperature(
      [row("train")],
      "2026-02-01T00:00:00Z",
    );
    const result = evaluateChronological(
      Array.from({ length: 1000 }, (_, i) =>
        row(`e-${i}`, {
          recordedAt: "2026-02-02T10:00:00Z",
          scheduledAt: "2026-02-02T11:00:00Z",
          resolvedAt: "2026-02-02T14:00:00Z",
          probability: 0.99,
          baselineProbability: 0.5,
        }),
      ),
      fitted,
    );
    expect(shadowPromotion(result)).toMatchObject({
      status: "review_candidate",
      predictiveClaim: false,
      automaticPromotion: false,
    });
  });
});
