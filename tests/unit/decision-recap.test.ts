import { describe, expect, it } from "vitest";
import {
  recapResult,
  recapConditionObservation,
  decisionRecapSchema,
} from "../../packages/domain/src/decision-recap";
const base = {
  pickOutcome: "Yes",
  confirmedAt: "2026-10-01T10:00:00Z",
  eventStartedAt: "2026-10-01T12:00:00Z",
  settlement: {
    status: "final" as const,
    winner: "Yes",
    verified: true,
    rulesMatch: true,
    sourceUrl: "https://kalshi.com",
    observedAt: "2026-10-01T14:00:00Z",
    revision: 1,
  },
};
describe("decision recap avoids hindsight scoring", () => {
  it("scores the observed pick without inferring reason validity", () => {
    expect(recapResult(base)).toMatchObject({ status: "final", pickWon: true });
    expect(
      recapResult({
        ...base,
        settlement: { ...base.settlement, winner: "No" },
      }),
    ).toMatchObject({ status: "final", pickWon: false });
  });
  it("waits for a verified final", () => {
    expect(recapResult({ ...base, settlement: null }).status).toBe("waiting");
    expect(
      recapResult({
        ...base,
        settlement: { ...base.settlement, verified: false },
      }).status,
    ).toBe("waiting");
    expect(
      recapResult({
        ...base,
        settlement: { ...base.settlement, status: "pending" },
      }).pickWon,
    ).toBeNull();
  });
  it.each([null, "2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z"])(
    "does not score unknown/post-start entry %s",
    (eventStartedAt) => {
      expect(recapResult({ ...base, eventStartedAt })).toMatchObject({
        status: "not_scored",
        pickWon: null,
      });
    },
  );
  it.each(["cancelled", "void"] as const)("does not score %s", (status) => {
    expect(
      recapResult({ ...base, settlement: { ...base.settlement, status } }),
    ).toMatchObject({ status: "not_scored", pickWon: null });
  });
  it("does not score rules mismatch or pre-event result", () => {
    expect(
      recapResult({
        ...base,
        settlement: { ...base.settlement, rulesMatch: false },
      }).status,
    ).toBe("not_scored");
    expect(
      recapResult({
        ...base,
        settlement: { ...base.settlement, observedAt: "2026-10-01T11:00:00Z" },
      }).status,
    ).toBe("not_scored");
  });
  it("keeps outcome and condition observations independent", () => {
    const value = {
      id: "r",
      ownerId: "u",
      pickId: "p",
      revision: 1,
      mode: "synthetic",
      initialReason: {
        text: "Expected starter",
        reasonId: null,
        pickVersion: 1,
        outcome: "Yes",
        confirmedAt: base.confirmedAt,
      },
      changes: [],
      choices: [],
      officialResult: recapResult(base),
      conditionOccurred: true,
      eventStartedAt: base.eventStartedAt,
      recordedAt: base.settlement.observedAt,
      predecessorId: null,
      evidenceRefs: [],
    };
    expect(decisionRecapSchema.parse(value).officialResult.pickWon).toBe(true);
    expect(decisionRecapSchema.parse(value).conditionOccurred).toBe(true);
    expect(
      decisionRecapSchema.safeParse({ ...value, savedMoney: 10 }).success,
    ).toBe(false);
  });
});

it.each(["waiting_confirmation", "check_unavailable"])(
  "retained %s cannot establish condition occurrence",
  (state) => {
    expect(
      recapConditionObservation({
        state,
        evidenceState: "contradicted",
        conditionMet: true,
      }),
    ).toBeNull();
    expect(
      recapConditionObservation({
        state,
        evidenceState: "supported",
        conditionMet: false,
      }),
    ).toBeNull();
  },
);
