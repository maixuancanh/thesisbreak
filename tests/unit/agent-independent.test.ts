import { it, expect } from "vitest";
import { runResearch } from "../../packages/agent/src/runtime";
it("loads independent source evidence without planner permission and preserves publication time", async () => {
  const output = await runResearch(
    {
      userId: "u",
      market: {
        platform: "kalshi",
        nativeId: "TEST",
        question: "A wins?",
        outcomes: ["Yes", "No"],
        rules: "Rules",
      },
      message: "Any news?",
      history: [],
      domain: "sports",
      now: new Date(),
    },
    {
      plan: async () => ({ tools: [] }),
      readPick: async () => null,
      readLessons: async () => [],
      readComparison: async () => [],
      marketSource: {
        id: "market",
        text: "Rules",
        url: "https://kalshi.com",
        retrievedAt: "2026-10-25T10:00:00Z",
      },
      readIndependent: async () => [
        {
          id: "news1",
          text: "Official report: Player out",
          url: "https://official.nba.com",
          retrievedAt: "2026-10-25T10:00:00Z",
          publishedAt: "2026-10-25T09:00:00Z",
        },
      ],
      generate: async (request) => {
        expect(
          JSON.parse(request.prompt).context.evidence.find(
            (e: { id: string }) => e.id === "news1",
          ).publishedAt,
        ).toBe("2026-10-25T09:00:00Z");
        return {
          message: "The official report lists the player out.",
          evidenceRefs: ["news1"],
          lessonRefs: [],
          proposedChange: null,
        };
      },
    },
  );
  expect(output.sources[0]?.url).toBe("https://official.nba.com");
  expect(output.trace.some((t) => t.tool === "read_independent_sources")).toBe(
    true,
  );
});
