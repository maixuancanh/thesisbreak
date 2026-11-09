import { expect, it } from "vitest";
import { retrieveLearningCandidates } from "../../packages/agent/src/learning-retrieval";
it("filters future knowledge and wrong event before lexical ranking", () => {
  const result = retrieveLearningCandidates({
    userId: "u",
    query: "Lakers",
    scope: { domain: "sports", eventId: "e1" },
    knownAt: new Date("2026-10-30T00:00:00Z"),
    items: [
      {
        id: "x",
        userId: "u",
        scope: { domain: "sports", eventId: "e2" },
        text: "Lakers",
        recordedAt: "2026-10-29T00:00:00Z",
        publishedAt: null,
        active: true,
        consented: true,
        verified: true,
      },
    ],
  });
  expect(result.items).toEqual([]);
  expect(result.mode).toBe("lexical");
  expect(result.embeddingStatus).toBe("not_configured");
});
