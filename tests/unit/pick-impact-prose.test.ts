import { describe, it, expect } from "vitest";
import { reasonConditionSchema } from "../../packages/domain/src/pick-reason";
import { evaluateProseImpact } from "../../packages/agent/src/pick-impact-prose";
const condition = reasonConditionSchema.parse({
  kind: "source_correction",
  subjectId: "player",
  eventIds: ["event"],
  statement: "Player is available",
  revisitWhen: "The report corrects availability",
  predicate: {
    type: "source_revision",
    referenceId: "report",
    revisitOn: "corrected",
  },
  sourcePolicy: "reviewed_primary",
  validFrom: "2026-11-01T00:00:00Z",
  validUntil: "2026-11-04T00:00:00Z",
});
const input = {
  condition,
  eventId: "event",
  observedAt: "2026-11-02T12:00:00Z",
  sourceAvailable: true,
  officialConfirmed: false,
  afterRef: "after",
  snapshots: {
    before: "Player is available.",
    after: "Correction: the player is unavailable.",
  },
};
const output = {
  subjectId: "player",
  eventId: "event",
  evidenceRefs: ["after"],
  quotedSpans: [
    { ref: "after", quote: "Correction: the player is unavailable." },
  ],
  evidenceState: "contradicted",
  conditionMet: true,
  explanation: "The publisher corrected the availability statement.",
};
describe("bounded prose impact policy", () => {
  it("does not translate a verified contradiction into a probability", () => {
    expect(evaluateProseImpact(input, output)).toMatchObject({
      decisionEvidence: {
        reasonImpact: "invalidated",
        priceAssessment: "unknown",
        adjustmentStatus: "insufficient_evidence",
        adjustedProbability: null,
      },
    });
  });
  it("accepts exact scoped material excerpts", () => {
    expect(evaluateProseImpact(input, output)).toMatchObject({
      state: "needs_review",
      conditionMet: true,
      evidenceState: "contradicted",
    });
  });
  it("rejects fabricated quotes, foreign refs and model mutation fields", () => {
    for (const value of [
      { ...output, quotedSpans: [{ ref: "after", quote: "Fabrication" }] },
      { ...output, evidenceRefs: ["foreign"] },
      { ...output, action: "sell" },
      { ...output, eventId: "different" },
    ])
      expect(evaluateProseImpact(input, value)).toMatchObject({
        state: "waiting_confirmation",
        conditionMet: null,
        evidenceState: "unclear",
      });
  });
  it("rumor cannot satisfy an official policy, and source failures stay unknown", () => {
    expect(
      evaluateProseImpact(
        {
          ...input,
          condition: { ...condition, sourcePolicy: "official_required" },
        },
        output,
      ),
    ).toMatchObject({
      state: "waiting_confirmation",
      conditionMet: null,
      evidenceState: "unclear",
    });
    expect(
      evaluateProseImpact({ ...input, sourceAvailable: false }, output),
    ).toMatchObject({
      state: "check_unavailable",
      conditionMet: null,
      evidenceState: "unclear",
    });
  });
  it("rejects out-of-event, expired and internally contradictory assessments", () => {
    for (const value of [
      { ...input, eventId: "another" },
      { ...input, observedAt: "2026-11-10T00:00:00Z" },
    ])
      expect(evaluateProseImpact(value, output).conditionMet).toBeNull();
    expect(
      evaluateProseImpact(input, {
        ...output,
        evidenceState: "supported",
        conditionMet: true,
      }),
    ).toMatchObject({ state: "waiting_confirmation", conditionMet: null });
  });
});
