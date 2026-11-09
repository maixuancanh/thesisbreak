import { expect, it } from "vitest";
import { classifyConsolidation } from "../../packages/agent/src/lesson-consolidation";
const evidence = [
  {
    atomId: "original",
    version: 1,
    hash: "h",
    stance: "support" as const,
    quote: "q",
  },
];
const original = {
  id: "old",
  statement: "Check original source",
  scope: { domain: "sports" },
  condition: null,
  evidence,
};
it("changed wording over identical support remains reviewable without more samples", () => {
  expect(
    classifyConsolidation({ ...original, statement: "Changed rule" }, [
      original,
    ]),
  ).toMatchObject({ classification: "no_increment", requiresReview: true });
});
it.each([
  { supportActive: false },
  { evidence: [{ ...evidence[0]!, version: 2, hash: "correction" }] },
  { evidence: [{ ...evidence[0]!, stance: "contradict" as const }] },
])("retains withdrawn or corrected support as conflict %j", (patch) => {
  const candidate = { ...original, ...("supportActive" in patch ? {} : patch) };
  const existing = { ...original, ...("supportActive" in patch ? patch : {}) };
  expect(classifyConsolidation(candidate, [existing]).classification).toBe(
    "conflict",
  );
});
it("scope restriction creates reviewable adaptation rather than inheriting approval", () => {
  expect(
    classifyConsolidation(
      { ...original, scope: { domain: "sports", eventId: "e" } },
      [original],
    ),
  ).toMatchObject({ classification: "scope_change", requiresReview: true });
});
it("separate unrelated events never merge", () => {
  expect(
    classifyConsolidation(
      {
        ...original,
        scope: { domain: "sports", eventId: "e2" },
        evidence: [{ ...evidence[0]!, atomId: "different" }],
      },
      [{ ...original, scope: { domain: "sports", eventId: "e1" } }],
    ).classification,
  ).toBe("new");
});
