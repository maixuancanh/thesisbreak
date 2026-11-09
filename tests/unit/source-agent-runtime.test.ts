import { expect, it } from "vitest";
import { buildSourceScore } from "../../packages/domain/src/source-credibility";
import { runResearch } from "../../packages/agent/src/runtime";
it("passes recalled source performance into model context and exposes its real sample count", async () => {
  const source = buildSourceScore({
    id: "s",
    userId: "u",
    sourceId: "market:kalshi",
    sourceName: "Kalshi",
    kind: "market_baseline",
    cohort: "sports:NBA",
    version: 1,
    updatedAt: "2026-10-27T00:00:00Z",
    forecasts: [],
  });
  const result = await runResearch(
    {
      userId: "u",
      market: {
        platform: "kalshi",
        nativeId: "KXTEST",
        question: "Example?",
        outcomes: ["Yes", "No"],
        rules: "Example",
      },
      message: "Whose forecast should I trust?",
      history: [],
      domain: "sports",
      competition: "NBA",
      now: new Date("2026-10-27T00:00:00Z"),
    },
    {
      plan: async () => ({ tools: [] }),
      generate: async (req) => {
        const context = JSON.parse(req.prompt).context;
        expect(context.sourceMemories[0].performance.scored).toBe(0);
        expect(req.system).toContain(
          "Zero scored events means unknown reliability",
        );
        return {
          message: "Kalshi has no scored events in your remembered record yet.",
          evidenceRefs: [],
          lessonRefs: [],
          proposedChange: null,
        };
      },
      readPick: async () => null,
      readLessons: async () => [],
      readSourceMemories: async () => [source],
      readComparison: async () => [],
      marketSource: {
        id: "market-source",
        text: "Terms",
        url: "https://kalshi.com",
        retrievedAt: "2026-10-27T00:00:00Z",
      },
    },
  );
  expect(result.recalledSources[0]?.sourceName).toBe("Kalshi");
  expect(
    result.trace.find((t) => t.tool === "recall_source_history")?.count,
  ).toBe(1);
});
