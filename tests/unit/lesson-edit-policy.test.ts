import { expect, it } from "vitest";
import { reviewedLessonEdit } from "../../packages/domain/src/lesson-edit-policy";

const original = {
  rule: "Wait for the official lineup",
  scope: { domain: "Sports", competition: "NBA", sourceClass: "official" },
  learningScope: { domain: "Sports", competition: "NBA", eventId: "event-a" },
  learningCondition: {
    type: "require_official_lineup" as const,
    expiresAt: "2026-11-04T00:00:00Z",
  },
};
it("invalidates the old machine policy after prose changes without broadening event scope", () => {
  const next = reviewedLessonEdit(original, {
    rule: "Compare the saved quote",
    scope: original.scope,
  });
  expect(next.rule).toBe("Compare the saved quote");
  expect(next.learningCondition).toBeUndefined();
  expect(next.learningScope).toEqual(original.learningScope);
  expect(next.scope.sourceClass).toBe("official");
});
it("preserves the exact reviewed machine policy for an unchanged rule and scope", () => {
  const next = reviewedLessonEdit(original, {
    rule: original.rule,
    scope: { sourceClass: "official", competition: "NBA", domain: "Sports" },
  });
  expect(next.learningCondition).toEqual(original.learningCondition);
});
it("invalidates the policy if its reviewed scope changes", () => {
  expect(
    reviewedLessonEdit(original, {
      rule: original.rule,
      scope: { domain: "Sports" },
    }).learningCondition,
  ).toBeUndefined();
});
it("does not introduce a machine policy into a plain preference", () => {
  const next = reviewedLessonEdit(
    { rule: "Be concise", scope: { domain: "Sports" } },
    { rule: "Explain disagreements", scope: { domain: "Sports" } },
  );
  expect(next.learningCondition).toBeUndefined();
});
