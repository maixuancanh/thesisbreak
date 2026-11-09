import { expect, it } from "vitest";
import { classifyConsolidation } from "../../packages/agent/src/lesson-consolidation";
it("does not count a paraphrase of the same evidence as reinforcement", () => {
  const evidence = [
    {
      atomId: "a",
      version: 1,
      hash: "h",
      stance: "support" as const,
      quote: "q",
    },
  ];
  expect(
    classifyConsolidation(
      {
        statement: "new wording",
        scope: { domain: "sports" },
        condition: null,
        evidence,
      },
      [
        {
          id: "old",
          statement: "old wording",
          scope: { domain: "sports" },
          condition: null,
          evidence,
        },
      ],
    ).classification,
  ).toBe("no_increment");
});
