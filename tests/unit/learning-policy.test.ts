import { expect, it } from "vitest";
import {
  rememberedConditions,
  evaluateLearningConditions,
} from "../../packages/agent/src/remembered-conditions";
const now = new Date("2026-10-30T06:00:00Z");
const base = {
  id: "l",
  userId: "u",
  version: 1,
  parentVersion: null,
  rule: "Check the quote",
  scope: { domain: "sports" },
  approval: "approved",
  status: "active",
  effectiveAt: "2026-10-29T00:00:00Z",
  expiresAt: null,
  supersededBy: null,
  learningScope: { domain: "sports", eventId: "e" },
  learningCondition: {
    type: "require_fresh_quote",
    maxAgeSeconds: 60,
    expiresAt: "2026-11-01T00:00:00Z",
  },
};
it("compiles typed current rules to fixed required reads and gates missing quotes", () => {
  const result = rememberedConditions({
    userId: "u",
    domain: "sports",
    eventId: "e",
    now,
    lessons: [base],
  });
  expect(result.requiredTools).toEqual(["read_tatum_quote"]);
  expect(
    evaluateLearningConditions(result, { now, sources: [] }).reasons,
  ).toContain("fresh_quote_required");
});
it("does not apply a different event or expired condition", () => {
  expect(
    rememberedConditions({
      userId: "u",
      domain: "sports",
      eventId: "other",
      now,
      lessons: [base],
    }).applied,
  ).toEqual([]);
  expect(
    rememberedConditions({
      userId: "u",
      domain: "sports",
      eventId: "e",
      now,
      lessons: [
        {
          ...base,
          learningCondition: {
            ...base.learningCondition,
            expiresAt: "2026-10-30T05:00:00Z",
          },
        },
      ],
    }).applied,
  ).toEqual([]);
});

it.each([
  [
    "require_official_lineup",
    "read_independent_sources",
    {
      id: "official",
      kind: "official_event",
      confirmsLineup: true,
      retrievedAt: now.toISOString(),
    },
  ],
  [
    "require_fresh_quote",
    "read_tatum_quote",
    {
      id: "quote",
      kind: "market",
      retrievedAt: now.toISOString(),
      quoteObservedAt: now.toISOString(),
    },
  ],
  [
    "compare_saved_snapshot",
    "compare_snapshot",
    { id: "snapshot", kind: "snapshot", retrievedAt: now.toISOString() },
  ],
] as const)(
  "requires and satisfies %s only from typed tool metadata",
  (type, tool, source) => {
    const condition = {
      type,
      expiresAt: "2026-11-01T00:00:00Z",
      ...(type === "require_fresh_quote" ? { maxAgeSeconds: 60 } : {}),
    };
    const rules = rememberedConditions({
      userId: "u",
      domain: "sports",
      eventId: "e",
      now,
      lessons: [{ ...base, learningCondition: condition }],
    });
    expect(rules.requiredTools).toEqual([tool]);
    expect(evaluateLearningConditions(rules, { now, sources: [] }).ready).toBe(
      false,
    );
    expect(
      evaluateLearningConditions(rules, { now, sources: [source] }).ready,
    ).toBe(true);
  },
);
it("copies and unknown origins never satisfy independent support", () => {
  const rules = rememberedConditions({
    userId: "u",
    domain: "sports",
    eventId: "e",
    now,
    lessons: [
      {
        ...base,
        learningCondition: {
          type: "require_independent_origin",
          minimumOrigins: 2,
          expiresAt: "2026-11-01T00:00:00Z",
        },
      },
    ],
  });
  const source = {
    id: "a",
    retrievedAt: now.toISOString(),
    canonicalOriginId: "origin",
    provenanceRefs: ["proof"],
  };
  expect(
    evaluateLearningConditions(rules, {
      now,
      sources: [source, { ...source, id: "copy" }],
    }).ready,
  ).toBe(false);
  expect(
    evaluateLearningConditions(rules, {
      now,
      sources: [
        source,
        { ...source, id: "other", canonicalOriginId: "independent" },
      ],
    }).ready,
  ).toBe(true);
});
