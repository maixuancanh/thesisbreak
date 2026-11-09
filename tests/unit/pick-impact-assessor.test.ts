import { describe, it, expect } from "vitest";
import { reasonConditionSchema } from "../../packages/domain/src/pick-reason";
import {
  assessPickCondition,
  validateImpactQuotes,
} from "../../packages/agent/src/pick-impact-assessor";
const condition = reasonConditionSchema.parse({
  kind: "official_lineup",
  subjectId: "player",
  eventIds: ["event"],
  statement: "Expected starter",
  revisitWhen: "Not a starter",
  predicate: {
    type: "lineup_status",
    expected: "starter",
    revisitOn: "not_starter",
  },
  sourcePolicy: "official_required",
  validFrom: "2026-11-01T00:00:00Z",
  validUntil: "2026-11-04T00:00:00Z",
});
const base = {
  condition,
  eventId: "event",
  observedAt: "2026-11-02T12:00:00Z",
  sourceAvailable: true,
  before: "starter",
  after: "available",
  referenceId: "report",
};
describe("scoped impact assessment", () => {
  it("retains reason review with missing price and no revised forecast", () => {
    expect(
      assessPickCondition({
        ...base,
        structured: {
          subjectId: "player",
          eventId: "event",
          official: true,
          lineupStatus: "not_starter",
        },
      }),
    ).toMatchObject({
      state: "needs_review",
      decisionEvidence: {
        reasonImpact: "invalidated",
        needsReview: true,
        priceAssessment: "unknown",
        adjustedProbability: null,
      },
    });
  });
  it("never treats available as starter or rumor as official lineup", () => {
    expect(
      assessPickCondition({
        ...base,
        structured: {
          subjectId: "player",
          eventId: "event",
          official: true,
          lineupStatus: "available",
        },
      }).state,
    ).toBe("waiting_confirmation");
    expect(
      assessPickCondition({
        ...base,
        structured: {
          subjectId: "player",
          eventId: "event",
          official: false,
          lineupStatus: "not_starter",
        },
      }).state,
    ).toBe("waiting_confirmation");
    expect(
      assessPickCondition({
        ...base,
        structured: {
          subjectId: "player",
          eventId: "event",
          official: true,
          lineupStatus: "not_starter",
        },
      }).state,
    ).toBe("needs_review");
  });
  it("excludes another event and expired conditions; untyped prose stays uncertain", () => {
    expect(assessPickCondition({ ...base, eventId: "another" }).inScope).toBe(
      false,
    );
    expect(
      assessPickCondition({ ...base, observedAt: "2026-11-05T00:00:00Z" })
        .inScope,
    ).toBe(false);
    expect(assessPickCondition(base).state).toBe("waiting_confirmation");
  });
  it("rejects fabricated or foreign quotes", () => {
    expect(
      validateImpactQuotes(
        { after: "Official source text" },
        {
          evidenceRefs: ["after"],
          quotedSpans: [{ ref: "after", quote: "source text" }],
        },
      ),
    ).toBe(true);
    expect(
      validateImpactQuotes(
        { after: "Official source text" },
        {
          evidenceRefs: ["after"],
          quotedSpans: [{ ref: "after", quote: "fabricated" }],
        },
      ),
    ).toBe(false);
    expect(
      validateImpactQuotes(
        { after: "source text" },
        {
          evidenceRefs: ["foreign"],
          quotedSpans: [{ ref: "foreign", quote: "source text" }],
        },
      ),
    ).toBe(false);
  });
  it("keeps rumor and unavailable predicate fields unknown as well as their state", () => {
    for (const input of [
      {
        ...base,
        structured: {
          subjectId: "player",
          eventId: "event",
          official: false,
          lineupStatus: "not_starter" as const,
        },
      },
      {
        ...base,
        sourceAvailable: false,
        structured: {
          subjectId: "player",
          eventId: "event",
          official: true,
          lineupStatus: "not_starter" as const,
        },
      },
    ]) {
      const r = assessPickCondition(input);
      expect(r.conditionMet).toBeNull();
      expect(r.evidenceState).toBe("unclear");
    }
  });
});
