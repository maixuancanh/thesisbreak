import {
  isLessonApplicable,
  type LessonContext,
} from "../packages/domain/src/lesson";
const context: LessonContext = {
  userId: "owner",
  domain: "sports",
  competition: "league-a",
  sourceClass: "official",
  now: new Date("2026-10-25T00:00:00Z"),
};
const base = {
  id: "lesson",
  userId: "owner",
  version: 1,
  parentVersion: null,
  rule: "Require official lineup evidence",
  scope: { domain: "sports", competition: "league-a", sourceClass: "official" },
  approval: "approved",
  status: "active",
  effectiveAt: "2026-10-01T00:00:00Z",
  expiresAt: null,
  supersededBy: null,
};
// Fixed held-out labels; no model inference or text generation is measured.
const mutations: [string, Record<string, unknown>, boolean][] = [
  ["applicable", {}, true],
  ["wrong-owner", { userId: "other" }, false],
  ["wrong-domain", { scope: { domain: "crypto" } }, false],
  [
    "wrong-competition",
    { scope: { domain: "sports", competition: "league-b" } },
    false,
  ],
  [
    "wrong-source",
    { scope: { domain: "sports", sourceClass: "rumor" } },
    false,
  ],
  ["paused", { status: "paused" }, false],
  ["retired", { status: "retired" }, false],
  ["pending", { approval: "pending" }, false],
  ["rejected", { approval: "rejected" }, false],
  ["superseded", { supersededBy: "replacement" }, false],
  ["future", { effectiveAt: "2026-11-01T00:00:00Z" }, false],
  ["expired", { expiresAt: "2026-10-24T00:00:00Z" }, false],
  ["domain-wide", { scope: { domain: "sports" } }, true],
  [
    "source-scoped",
    { scope: { domain: "sports", sourceClass: "official" } },
    true,
  ],
  [
    "competition-scoped",
    { scope: { domain: "sports", competition: "league-a" } },
    true,
  ],
  ["expiry-boundary", { expiresAt: "2026-10-25T00:00:00Z" }, false],
  ["effective-boundary", { effectiveAt: "2026-10-25T00:00:00Z" }, true],
  ["next-day-expiry", { expiresAt: "2026-10-26T00:00:00Z" }, true],
  ["malformed-scope", { scope: {} }, false],
  ["invalid-version", { version: 0 }, false],
  ["invalid-ancestry", { version: 2, parentVersion: null }, false],
  ["blank-rule", { rule: "" }, false],
  ["unknown-status", { status: "archived" }, false],
  [
    "wrong-owner-active",
    { userId: "another", scope: { domain: "sports" } },
    false,
  ],
];
export const memoryPolicyCases = mutations.map(([id, patch, expected]) => ({
  id,
  lesson: { ...base, ...patch },
  expected,
  context,
}));
export function evaluateMemoryPolicy() {
  const score = (
    predict: (c: (typeof memoryPolicyCases)[number]) => boolean,
  ) => {
    let truePositive = 0,
      falsePositive = 0,
      falseNegative = 0,
      trueNegative = 0;
    for (const c of memoryPolicyCases) {
      const result = predict(c);
      if (result && c.expected) truePositive++;
      else if (result) falsePositive++;
      else if (c.expected) falseNegative++;
      else trueNegative++;
    }
    return { truePositive, falsePositive, falseNegative, trueNegative };
  };
  return {
    measurement: "deterministic applicability policy; not LLM quality",
    cases: memoryPolicyCases.length,
    noMemory: score(() => false),
    scopedStructured: score((c) => isLessonApplicable(c.lesson, c.context)),
  };
}
