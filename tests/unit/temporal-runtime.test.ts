import { expect, it, vi } from "vitest";
import { runResearch } from "../../packages/agent/src/runtime";
import { parseTemporalRequest } from "../../packages/agent/src/temporal-retrieval";
const base = {
  userId: "u",
  market: {
    platform: "kalshi" as const,
    nativeId: "n",
    question: "FINAL WINNER SECRET",
    outcomes: ["Yes", "No"],
    rules: "NEW RULE SECRET",
  },
  message: "What was known as of 2026-10-29T00:00:00Z?",
  history: [{ role: "assistant" as const, text: "FUTURE HISTORY SECRET" }],
  domain: "sports",
  now: new Date("2026-10-30T00:00:00Z"),
};
it("does not treat ordinary before workflow wording as a historical request", () => {
  expect(
    parseTemporalRequest("Wait for official lineup before reconsidering a pick")
      .status,
  ).toBe("current");
});
it("excludes every current context path and postcutoff original from historical generator", async () => {
  const current = vi.fn(async () => {
    throw Error("CURRENT_CONTEXT_MUST_NOT_LOAD");
  });
  const r = await runResearch(base, {
    plan: async () => ({ tools: ["read_tatum_quote"] }),
    generate: async (input) => {
      expect(input.system).toContain("Historical reconstruction only");
      expect(input.prompt).not.toMatch(/SECRET|FUTURE_DATA|UNKNOWN_TIME/);
      expect(input.prompt).toContain("Original before cutoff");
      return {
        message: "Only recorded facts available",
        evidenceRefs: [],
        lessonRefs: [],
        proposedChange: null,
      };
    },
    readPick: current,
    readLessons: current,
    readIndependent: current,
    readComparison: current,
    readTatumQuote: current,
    marketSource: {
      id: "m",
      url: "",
      text: "CURRENT MARKET SECRET",
      retrievedAt: "2026-10-30T00:00:00Z",
    },
    readHistoricalEvidence: async () => [
      {
        id: "old",
        url: "",
        text: "Original before cutoff",
        publishedAt: "2026-10-28T00:00:00Z",
        retrievedAt: "2026-10-28T01:00:00Z",
      },
      {
        id: "future",
        url: "",
        text: "FUTURE_DATA",
        publishedAt: "2026-10-28T00:00:00Z",
        retrievedAt: "2026-10-30T00:00:00Z",
      },
      {
        id: "unknown",
        url: "",
        text: "UNKNOWN_TIME",
        publishedAt: null,
        retrievedAt: "2026-10-28T00:00:00Z",
      },
    ],
  });
  expect(current).not.toHaveBeenCalled();
  expect(r.reply.proposedChange).toBeNull();
  expect(r.learningEvidence).toEqual([]);
  expect("temporalContext" in r && r.temporalContext.coverage).toBe(
    "recorded_originals",
  );
});
it("rejects incomplete cutoffs before loading model or account data", async () => {
  const read = vi.fn();
  await expect(
    runResearch(
      { ...base, message: "as of yesterday" },
      {
        plan: read,
        generate: read,
        readPick: read,
        readLessons: read,
        readComparison: read,
        marketSource: { id: "m", url: "", text: "", retrievedAt: "" },
      },
    ),
  ).rejects.toThrow("HISTORICAL_CUTOFF_CLARIFICATION_REQUIRED");
  expect(read).not.toHaveBeenCalled();
});
