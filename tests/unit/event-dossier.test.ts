import { describe, expect, it } from "vitest";
import {
  applyDossierPatch,
  dossierState,
  affectedDecisions,
  revalidateDecision,
} from "../../packages/agent/src/event-dossier";
const dep = {
  id: "fact",
  version: 1,
  hash: "a".repeat(64),
  status: "current" as const,
};
const dossier = {
  ownerId: "u",
  eventId: "e",
  revision: 1,
  checkedAt: "2026-10-30T00:00:00Z",
  blocks: { reasons: { text: "original", dependencies: [dep] } },
};
describe("event dossiers", () => {
  it("patches only changed blocks and preserves immutable revisions", () => {
    const next = applyDossierPatch(dossier, {
      ownerId: "u",
      eventId: "e",
      baseRevision: 1,
      checkedAt: dossier.checkedAt,
      changes: { unknowns: { text: "lineup unknown", dependencies: [] } },
    });
    expect(next.revision).toBe(2);
    expect(next.blocks.reasons).toEqual(dossier.blocks.reasons);
    expect(dossier.blocks).not.toHaveProperty("unknowns");
  });
  it("rejects foreign scope, stale patch, and protected field edits", () => {
    const patch = {
      ownerId: "u",
      eventId: "e",
      baseRevision: 1,
      checkedAt: dossier.checkedAt,
      changes: {},
    };
    expect(() =>
      applyDossierPatch(dossier, { ...patch, ownerId: "other" }),
    ).toThrow("FORBIDDEN");
    expect(() =>
      applyDossierPatch(dossier, { ...patch, baseRevision: 2 }),
    ).toThrow("REVISION_CONFLICT");
    expect(() =>
      applyDossierPatch(dossier, {
        ...patch,
        changes: {
          conditions: { text: "change confirmed rule", dependencies: [] },
        },
      }),
    ).toThrow("PROTECTED_BLOCK");
  });
  it("distinguishes empty, partial, stale, fresh and failed refresh", () => {
    expect(dossierState({ ...dossier, blocks: {} }, [dep])).toBe("empty");
    expect(dossierState(dossier, [dep])).toBe("partial");
    expect(dossierState(dossier, [{ ...dep, version: 2 }])).toBe("stale");
    expect(dossierState(dossier, [dep], { failed: true })).toBe(
      "failed_refresh",
    );
    const blocks = Object.fromEntries(
      [
        "savedView",
        "reasons",
        "conditions",
        "evidence",
        "unknowns",
        "sourceHistory",
      ].map((k) => [k, dossier.blocks.reasons]),
    );
    expect(dossierState({ ...dossier, blocks }, [dep])).toBe("fresh");
  });
  it("targets exact dependent advice only, respecting monitoring and consent", () => {
    const decisions = [
      {
        id: "a",
        ownerId: "u",
        monitoring: true,
        consent: true,
        dependencies: [dep],
      },
      {
        id: "b",
        ownerId: "u",
        monitoring: false,
        consent: true,
        dependencies: [dep],
      },
      {
        id: "c",
        ownerId: "other",
        monitoring: true,
        consent: true,
        dependencies: [dep],
      },
    ];
    expect(affectedDecisions("u", decisions, { ...dep, version: 2 })).toEqual([
      "a",
    ]);
    expect(affectedDecisions("u", decisions, dep)).toEqual([]);
  });
  it("blocks confirmation on changed versions, unavailable evidence, consent or event start", () => {
    const input = {
      expectedPickVersion: 1,
      currentPickVersion: 1,
      expectedLessonVersion: 1,
      currentLessonVersion: 1,
      dependencies: [dep],
      currentDependencies: [dep],
      consent: true,
      now: "2026-10-30T00:00:00Z",
      eventStartsAt: "2026-10-31T00:00:00Z",
    };
    expect(revalidateDecision(input)).toEqual({ allowed: true, reasons: [] });
    expect(
      revalidateDecision({
        ...input,
        currentDependencies: [{ ...dep, status: "unavailable" }],
      }).reasons,
    ).toContain("DEPENDENCY_UNAVAILABLE");
    expect(
      revalidateDecision({
        ...input,
        consent: false,
        currentPickVersion: 2,
        now: input.eventStartsAt,
      }).allowed,
    ).toBe(false);
    expect(
      revalidateDecision({
        ...input,
        dependencies: [{ ...dep, status: "revoked" }],
      }).allowed,
    ).toBe(false);
  });
});
