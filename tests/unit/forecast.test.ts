import { describe, expect, it } from "vitest";
import { forecastEligibility, gradeForecast, sourcePerformance } from "../../packages/domain/src/forecast";

const base = { eventId: "game-1", recordedAt: "2026-10-27T10:00:00Z", scheduledAt: "2026-10-27T11:00:00Z", resolvedAt: "2026-10-27T14:00:00Z", outcome: "A", winner: "A", status: "final" as const, probability: 0.7, baselineProbability: 0.6 };
describe("pre-event forecast authority", () => {
  it("accepts strictly before start; rejects at/after start irrespective of later settlement", () => {
    expect(forecastEligibility(base.recordedAt, base.scheduledAt)).toBe("eligible");
    expect(forecastEligibility(base.scheduledAt, base.scheduledAt)).toBe("event_started");
    expect(forecastEligibility("2026-10-27T12:00:00Z", base.scheduledAt)).toBe("event_started");
  });
  it("never substitutes close time or guesses an unknown/invalid start", () => {
    expect(forecastEligibility(base.recordedAt, null)).toBe("start_unknown");
    expect(forecastEligibility(base.recordedAt, "invalid")).toBe("start_unknown");
    expect(forecastEligibility("invalid", base.scheduledAt)).toBe("invalid_recording");
  });
});
describe("deterministic result grading", () => {
  it("scores explicit probabilities and the frozen same-outcome baseline", () => {
    const grade = gradeForecast(base);
    expect(grade.comparison).toBe("matched");
    expect(grade.brier).toBeCloseTo(0.09);
    expect(grade.baselineBrier).toBeCloseTo(0.16);
    expect(gradeForecast({...base, winner:"B"}).brier).toBeCloseTo(0.49);
  });
  it("does not invent probabilities for directional calls", () => {
    expect(gradeForecast({...base, probability:null})).toMatchObject({comparison:"matched", brier:null,baselineBrier:null});
  });
  it("excludes pending/void and late/unknown-start entries", () => {
    for (const status of ["pending", "void", "disputed"] as const) expect(gradeForecast({...base,status}).comparison).toBe("not_scored");
    expect(gradeForecast({...base,scheduledAt:null}).comparison).toBe("not_scored");
    expect(gradeForecast({...base,recordedAt:base.scheduledAt}).comparison).toBe("not_scored");
    expect(gradeForecast({...base,resolvedAt:base.recordedAt}).comparison).toBe("not_scored");
  });
  it("rejects invalid probabilities rather than clamping them", () => {
    expect(()=>gradeForecast({...base,probability:1.2})).toThrow();
    expect(()=>gradeForecast({...base,baselineProbability:NaN})).toThrow();
  });
});
describe("source performance", () => {
  it("uses distinct events, explicit latest revisions and a paired benchmark cohort", () => {
    const g = gradeForecast(base);
    const rows = [{eventId:"a",revision:1,grade:g},{eventId:"a",revision:2,grade:gradeForecast({...base,winner:"B"})},{eventId:"b",revision:1,grade:gradeForecast({...base,probability:null})}];
    const s=sourcePerformance(rows);
    expect(s).toMatchObject({events:2,scored:2,matched:1,probabilitySamples:1,pairedSamples:1});
    expect(s.meanBrier).toBeCloseTo(0.49);
    expect(s.meanBaselineBrier).toBeCloseTo(0.36);
    expect(s.pairedImprovement).toBeCloseTo(-0.13);
  });
  it("retracts a previous grade when a newer correction voids it", () => {
    expect(sourcePerformance([{eventId:"a",revision:1,grade:gradeForecast(base)},{eventId:"a",revision:2,grade:gradeForecast({...base,status:"void"})}])).toMatchObject({events:1,scored:0,meanBrier:null,pairedImprovement:null});
  });
  it("refuses ambiguous same-revision duplicates", () => {
    const r={eventId:"a",revision:1,grade:gradeForecast(base)};
    expect(()=>sourcePerformance([r,{...r,grade:gradeForecast({...base,winner:"B"})}])).toThrow("AMBIGUOUS_REVISION");
  });
});
