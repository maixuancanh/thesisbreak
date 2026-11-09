import { describe, expect, it } from "vitest";
import {
  assessActionUsefulness,
  assessMemoryValidity,
  assessResearchReadiness,
  assessSourceSpecialization,
  compareReasonEvidence,
  groupCanonicalOrigins,
} from "../../packages/domain/src/research-policy";

const scope = { league: "NBA", market: "winner", horizon: "pregame" };
describe("research evidence policy", () => {
  it("separates factual correctness from absent forecast quality and rejects scope transfer", () => {
    const input = {
      scope,
      requestedScope: scope,
      factChecks: { correct: 9, total: 10, evidenceRefs: ["facts"] },
      forecasts: { resolved: 0, brierScore: null, evidenceRefs: [] },
    };
    expect(assessSourceSpecialization(input)).toMatchObject({
      applicable: true,
      factCorrectness: { rate: 0.9 },
      forecastQuality: { brierScore: null },
    });
    for (const requestedScope of [
      { ...scope, league: "NFL" },
      { ...scope, market: "spread" },
      { ...scope, horizon: "live" },
    ]) {
      expect(
        assessSourceSpecialization({ ...input, requestedScope }),
      ).toMatchObject({ applicable: false, factCorrectness: { rate: null } });
    }
    expect(() =>
      assessSourceSpecialization({
        ...input,
        forecasts: { resolved: 5, brierScore: 0.1, evidenceRefs: [] },
      }),
    ).toThrow();
    expect(() =>
      assessSourceSpecialization({
        ...input,
        factChecks: { correct: 11, total: 10, evidenceRefs: ["a"] },
      }),
    ).toThrow();
  });
  it("deduplicates explicit origins without counting unknown URLs as independent", () => {
    const source = {
      id: "a",
      url: "https://a.test/report",
      canonicalOriginId: "wire-1",
      provenanceRefs: ["attribution"],
    };
    expect(
      groupCanonicalOrigins([
        source,
        { ...source, id: "b", url: "https://b.test/copy" },
        { ...source, id: "c", canonicalOriginId: null, provenanceRefs: [] },
      ]),
    ).toEqual({
      groups: [{ canonicalOriginId: "wire-1", sourceIds: ["a", "b"] }],
      unknownSourceIds: ["c"],
      independence: "not_established",
    });
    expect(() =>
      groupCanonicalOrigins([{ ...source, provenanceRefs: [] }]),
    ).toThrow();
    expect(() => groupCanonicalOrigins([source, source])).toThrow(
      "DUPLICATE_SOURCE_ID",
    );
  });
  it("expires memory at its boundary and invalidates changed regimes", () => {
    const input = {
      now: "2026-10-28T12:00:00Z",
      recordedAt: "2026-10-28T10:00:00Z",
      expiresAt: "2026-10-28T13:00:00Z",
      regime: "regular",
      currentRegime: "regular",
      scope,
      requestedScope: scope,
      active: true,
      evidenceRefs: ["e"],
    };
    expect(assessMemoryValidity(input).applicable).toBe(true);
    expect(
      assessMemoryValidity({ ...input, now: input.expiresAt }).reasons,
    ).toContain("expired");
    expect(
      assessMemoryValidity({ ...input, currentRegime: "playoffs" }).reasons,
    ).toContain("regime_changed");
    expect(
      assessMemoryValidity({ ...input, now: "2026-10-28T09:00:00Z" }).reasons,
    ).toContain("future_record");
    expect(
      assessMemoryValidity({ ...input, active: false, evidenceRefs: [] })
        .applicable,
    ).toBe(false);
    expect(() => assessMemoryValidity({ ...input, now: "invalid" })).toThrow();
  });
  it("waits for required lineups and abstains on stale, conflicting or missing evidence", () => {
    const input = {
      requiresLineup: true,
      lineupConfirmed: false,
      staleEvidence: false,
      conflictingEvidence: false,
      evidenceRefs: ["e"],
    };
    expect(assessResearchReadiness(input).action).toBe("wait");
    expect(
      assessResearchReadiness({ ...input, lineupConfirmed: true }).action,
    ).toBe("ready");
    for (const flags of [
      { staleEvidence: true },
      { conflictingEvidence: true },
      { evidenceRefs: [] },
    ])
      expect(assessResearchReadiness({ ...input, ...flags }).action).toBe(
        "abstain",
      );
  });
  it("does not infer improvement from winning, waiting or changing picks", () => {
    for (const action of [
      "changed_pick",
      "waited",
      "abstained",
      "unchanged",
    ] as const) {
      const input = {
        action,
        evidenceRefs: ["e"],
        outcomeObserved: true,
        evaluation: "observational" as const,
        evaluationRefs: ["eval"],
        measuredImprovement: 0.2,
      };
      expect(assessActionUsefulness(input)).toMatchObject({
        improvementSupported: false,
        evidenceLevel: "observational",
      });
      expect(
        assessActionUsefulness({ ...input, evaluation: "controlled" })
          .improvementSupported,
      ).toBe(true);
      expect(
        assessActionUsefulness({
          ...input,
          evaluation: "controlled",
          measuredImprovement: -0.1,
        }).improvementSupported,
      ).toBe(false);
    }
  });
  it("makes before/after evidence differences reviewable without claiming better reasoning", () => {
    const input = {
      before: { text: "Favor home", evidenceRefs: ["old"] },
      after: { text: "Wait for lineup", evidenceRefs: ["new"] },
      availableEvidenceRefs: ["old", "new"],
    };
    expect(compareReasonEvidence(input)).toMatchObject({
      changed: true,
      grounded: true,
      addedEvidenceRefs: ["new"],
      removedEvidenceRefs: ["old"],
      improvementEstablished: false,
    });
    expect(
      compareReasonEvidence({ ...input, availableEvidenceRefs: ["old"] }),
    ).toMatchObject({ grounded: false, unknownEvidenceRefs: ["new"] });
  });
});
