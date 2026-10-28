import { expect, it } from "vitest";
import { runResearch } from "../../packages/agent/src/runtime";
it("recalls memory before planning and changes the actual read performed", async () => {
  const run = async (enabled: boolean) => {
    const actions: string[] = [];
    const result = await runResearch(
      {
        userId: "u",
        market: {
          platform: "kalshi",
          nativeId: "TEST",
          question: "A wins?",
          outcomes: ["Yes", "No"],
          rules: null,
        },
        message: "Has anything changed?",
        history: [],
        domain: "sports",
        now: new Date(),
      },
      {
        readPick: async () => null,
        readLessons: async () => [],
        readComparison: async () => [],
        readSessionMemories: async () => {
          actions.push("recall");
          return enabled
            ? [
                {
                  sessionId: "session-a",
                  version: 1,
                  blobId: "blob-a",
                  recordedAt: "2026-10-27T00:00:00Z",
                  payload: {
                    turns: [
                      {
                        user: "Compare the current odds with the seven-day price history before discussing a change.",
                      },
                    ],
                  },
                },
              ]
            : [];
        },
        plan: async (input) => {
          actions.push("plan");
          return {
            tools: input.sessionMemories?.length ? ["read_tatum_history"] : [],
          };
        },
        readTatumHistory: async () => {
          actions.push("read_history");
          return [];
        },
        generate: async () => ({
          message: "Waiting for evidence.",
          evidenceRefs: [],
          lessonRefs: [],
          proposedChange: null,
        }),
        marketSource: {
          id: "market-source",
          text: "terms",
          retrievedAt: "2026-10-28T00:00:00Z",
          url: "https://kalshi.com",
        },
      },
    );
    return { actions, result };
  };
  expect((await run(true)).actions).toEqual(["recall", "plan", "read_history"]);
  expect((await run(false)).actions).toEqual(["recall", "plan"]);
});
