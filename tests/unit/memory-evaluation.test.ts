import { expect, it } from "vitest";
import {
  evaluateMemoryPolicy,
  memoryPolicyCases,
} from "../../evals/memory-policy";
it("evaluates at least 24 independently labelled heldout policy cases", () => {
  expect(memoryPolicyCases.length).toBeGreaterThanOrEqual(24);
  const r = evaluateMemoryPolicy();
  expect(r.scopedStructured.falsePositive).toBe(0);
  expect(r.scopedStructured.falseNegative).toBe(0);
  expect(r.noMemory.truePositive).toBe(0);
  expect(r.noMemory.falseNegative).toBeGreaterThan(0);
});
