import { it, expect } from "vitest";
import { usefulMemoryInventory } from "../../packages/domain/src/useful-memory-inventory";
const base = {
  logicalId: "one",
  type: "lesson",
  version: 1,
  verified: true,
  consented: true,
  active: true,
  evaluationOnly: false,
  utility: "useful",
  semanticKey: "lineup",
};
it("does not count revisions, receipts, semantic copies or workflow tests as additional useful lessons", () => {
  const result = usefulMemoryInventory([
    { ...base },
    { ...base, version: 2 },
    { ...base, logicalId: "copy" },
    { ...base, logicalId: "test", evaluationOnly: true },
    { ...base, logicalId: "pending", verified: false },
    {
      ...base,
      logicalId: "receipt",
      type: "decision.receipt",
      semanticKey: "receipt",
    },
  ]);
  expect(result.reviewedUsefulDistinct).toBe(1);
  expect(result.meetsTenUsefulMemories).toBe(false);
  expect(result.evaluationRecordsExcluded).toBe(1);
});
it("requires current authority and explicit utility review rather than equating verified blobs with value", () => {
  expect(
    usefulMemoryInventory([
      { ...base, utility: "unreviewed" },
      { ...base, version: 2, active: false },
    ]).reviewedUsefulDistinct,
  ).toBe(0);
  expect(
    usefulMemoryInventory(
      Array.from({ length: 10 }, (_, i) => ({
        ...base,
        logicalId: String(i),
        semanticKey: `distinct-${i}`,
      })),
    ).meetsTenUsefulMemories,
  ).toBe(true);
});
