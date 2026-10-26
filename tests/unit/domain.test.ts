import { describe, it, expect } from "vitest";
import {
  marketKey,
  pickVersionSchema,
  isLessonApplicable,
  changeProposalSchema,
  validateProposalAcceptance,
  watchPlanSchema,
  marketSnapshotSchema,
} from "../../packages/domain/src/index";
const now = new Date("2026-10-22T00:00:00Z");
const pick = {
  userId: "u1",
  pickId: "p1",
  version: 1,
  parentVersion: null,
  market: { platform: "kalshi", nativeId: "same" },
  outcome: "NO",
  createdAt: now.toISOString(),
};
const lesson = {
  id: "l1",
  userId: "u1",
  version: 1,
  parentVersion: null,
  rule: "Check official lineup",
  scope: { domain: "football", competition: "EPL", sourceClass: "official" },
  approval: "approved",
  status: "active",
  effectiveAt: "2026-10-21T00:00:00Z",
  expiresAt: "2026-10-23T00:00:00Z",
  supersededBy: null,
};
const context = {
  userId: "u1",
  domain: "football",
  competition: "EPL",
  sourceClass: "official",
  now,
};
describe("domain invariants", () => {
  it("uses both platform and native id", () =>
    expect(marketKey({ platform: "kalshi", nativeId: "same" })).not.toBe(
      marketKey({ platform: "polymarket", nativeId: "same" }),
    ));
  it("does not invent assumptions when reason absent", () =>
    expect(pickVersionSchema.parse(pick)).toMatchObject({ assumptions: [] }));
  it("rejects disconnected ancestry", () =>
    expect(
      pickVersionSchema.safeParse({ ...pick, version: 3, parentVersion: 1 })
        .success,
    ).toBe(false));
  it.each([
    { userId: "u2" },
    { approval: "pending" },
    { status: "retired" },
    { supersededBy: "l2" },
    { expiresAt: now.toISOString() },
    { scope: { domain: "politics" } },
  ])("excludes inapplicable lesson %j", (patch) =>
    expect(isLessonApplicable({ ...lesson, ...patch }, context)).toBe(false),
  );
  it("allows approved current matching lesson", () =>
    expect(isLessonApplicable(lesson, context)).toBe(true));
  it("rejects arbitrary change fields", () =>
    expect(
      changeProposalSchema.safeParse({
        id: "c1",
        userId: "u1",
        pickId: "p1",
        baseVersion: 1,
        changes: { userId: "u2" },
        reason: "change",
        evidenceRefs: [],
        expiresAt: "2026-10-23T00:00:00Z",
        status: "pending",
      }).success,
    ).toBe(false));
  it("rejects stale proposal version", () =>
    expect(() =>
      validateProposalAcceptance(
        {
          id: "c1",
          userId: "u1",
          pickId: "p1",
          baseVersion: 1,
          changes: { outcome: "YES" },
          reason: "change",
          evidenceRefs: [],
          expiresAt: "2026-10-23T00:00:00Z",
          status: "pending",
        },
        { userId: "u1", pickId: "p1", currentVersion: 2, now },
      ),
    ).toThrow("VERSION_CONFLICT"));
});
describe("strict approval boundaries", () => {
  const proposal = {
    id: "c1",
    userId: "u1",
    pickId: "p1",
    baseVersion: 1,
    changes: { outcome: "YES" },
    reason: "Official evidence",
    evidenceRefs: [],
    expiresAt: "2026-10-23T00:00:00Z",
    status: "pending",
  };
  it.each([{ userId: "u2" }, { pickId: "other" }])(
    "refuses foreign context %j",
    (patch) =>
      expect(() =>
        validateProposalAcceptance(proposal, {
          userId: "u1",
          pickId: "p1",
          currentVersion: 1,
          now,
          ...patch,
        }),
      ).toThrow("FORBIDDEN"),
  );
  it("refuses expired proposal", () =>
    expect(() =>
      validateProposalAcceptance(
        { ...proposal, expiresAt: now.toISOString() },
        { userId: "u1", pickId: "p1", currentVersion: 1, now },
      ),
    ).toThrow("PROPOSAL_EXPIRED"));
  it("refuses accepted proposal execution without idempotency replay", () =>
    expect(() =>
      validateProposalAcceptance(
        { ...proposal, status: "accepted" },
        { userId: "u1", pickId: "p1", currentVersion: 1, now },
      ),
    ).toThrow("PROPOSAL_NOT_PENDING"));
  it("rejects empty proposals", () =>
    expect(
      changeProposalSchema.safeParse({ ...proposal, changes: {} }).success,
    ).toBe(false));
  it("does not use a lesson in a different competition", () =>
    expect(
      isLessonApplicable(lesson, { ...context, competition: "La Liga" }),
    ).toBe(false));
  it("does not use a lesson before its effective time", () =>
    expect(
      isLessonApplicable(
        { ...lesson, effectiveAt: "2026-10-22T01:00:00Z" },
        context,
      ),
    ).toBe(false));
  it("does not use official source lessons for rumors", () =>
    expect(
      isLessonApplicable(lesson, { ...context, sourceClass: "rumor" }),
    ).toBe(false));
  it("requires approved future watch deadline", () =>
    expect(
      watchPlanSchema.safeParse({
        id: "w1",
        pickId: "p1",
        pickVersion: 1,
        version: 1,
        parentVersion: null,
        condition: { kind: "lineup_changed", assumptionId: "a1" },
        sourceIds: ["official"],
        procedureVersion: "1",
        deadline: "2026-10-21T00:00:00Z",
        timezone: "UTC",
        channel: "in_app",
        approvedAt: now.toISOString(),
        state: "active",
      }).success,
    ).toBe(false));
  it("rejects duplicate outcomes in market snapshots", () =>
    expect(
      marketSnapshotSchema.safeParse({
        market: { platform: "kalshi", nativeId: "m" },
        eventId: null,
        question: "Match?",
        outcomes: ["YES", "YES"],
        rulesReference: "https://example.com/rules",
        rulesHash: "hash",
        closeTime: null,
        fetchedAt: now.toISOString(),
        priceAsOf: now.toISOString(),
        nativeUnit: "cents",
      }).success,
    ).toBe(false));
});
