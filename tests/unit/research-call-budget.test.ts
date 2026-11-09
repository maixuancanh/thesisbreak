import { it, expect } from "vitest";
import { researchCallBudget } from "../../packages/domain/src/research-call-budget";
it("reserves baseline and exactly one debate without overrunning", () => {
  const b = researchCallBudget(5);
  expect(b.reserve(1)).toBe(true);
  expect(b.reserve(1)).toBe(true);
  expect(b.reserve(3)).toBe(true);
  expect(b.reserve(1)).toBe(false);
  expect(b.used).toBe(5);
});
it("cannot silently enable debate on a baseline budget", () => {
  const b = researchCallBudget(2);
  expect(b.reserve(3)).toBe(false);
  expect(b.reserve(0)).toBe(false);
  expect(b.used).toBe(0);
});
