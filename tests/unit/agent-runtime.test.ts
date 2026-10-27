import { describe, it, expect, vi } from "vitest";
import {
  createAgentContext,
  answerWithContext,
} from "../../packages/agent/src/context";
import {
  runResearch,
  readPlanSchema,
  recentHistory,
} from "../../packages/agent/src/runtime";
const market = {
  platform: "kalshi" as const,
  nativeId: "TEST",
  question: "A wins?",
  outcomes: ["Yes", "No"],
  rules: "Official rules",
};
const reply = {
  message: "The supplied market rules describe settlement, not team news.",
  evidenceRefs: ["market-source"],
  lessonRefs: [],
  proposedChange: null,
};
describe("contextual agent read tool runtime", () => {
  it("loads approved preferences even when the planner omits their read", async () => {
    const lessons = vi.fn(async () => []);
    const result = await runResearch(
      {
        userId: "u",
        market,
        message: "Explain",
        history: [],
        domain: "sports",
        now: new Date(),
      },
      {
        plan: async () => ({ tools: [] }),
        generate: async () => reply,
        readPick: async () => null,
        readLessons: lessons,
        readComparison: async () => [],
        marketSource: {
          id: "market-source",
          text: "terms",
          retrievedAt: "2026-10-23T00:00:00Z",
          url: "https://kalshi.com",
        },
      },
    );
    expect(lessons).toHaveBeenCalledTimes(1);
    expect(result.trace.some((t) => t.tool === "read_approved_lessons")).toBe(
      true,
    );
  });
  it("bounds long history by dropping oldest complete exchanges", () => {
    const input = Array.from({ length: 8 }, (_, i) => [
      { role: "user" as const, text: `question ${i}` },
      { role: "assistant" as const, text: String(i).repeat(12000) },
    ]).flat();
    const kept = recentHistory(input);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(30000);
    expect(kept).toHaveLength(4);
    expect(kept[0]?.text).toBe("question 6");
    expect(input).toHaveLength(16);
  });
  it("executes only planned bounded reads, passes history and returns source trace", async () => {
    const pick = vi.fn(async () => null);
    const gen = vi.fn(async (req) => {
      expect(JSON.parse(req.prompt).history[0].text).toBe("Earlier question");
      return reply;
    });
    const result = await runResearch(
      {
        userId: "u",
        market,
        message: "Explain",
        history: [{ role: "user", text: "Earlier question" }],
        now: new Date(),
        domain: "sports",
      },
      {
        plan: async () => ({ tools: ["read_saved_pick", "compare_snapshot"] }),
        generate: gen,
        readPick: pick,
        readLessons: async () => [],
        readComparison: async () => [],
        marketSource: {
          id: "market-source",
          text: "Verified terms",
          retrievedAt: "2026-10-23T00:00:00Z",
          url: "https://kalshi.com",
        },
      },
    );
    expect(pick).toHaveBeenCalledTimes(1);
    expect(result.trace.map((t) => t.tool)).toEqual([
      "read_market",
      "read_saved_pick",
      "read_approved_lessons",
      "compare_snapshot",
    ]);
    expect(result.sources[0]?.url).toBe("https://kalshi.com");
    expect(result.reply).toEqual(reply);
  });
  it("accepts a new pick draft only with native outcomes and never writes it", async () => {
    const context = createAgentContext({
      userId: "u",
      market,
      pick: null,
      evidence: [],
      lessons: [],
      now: new Date(),
    });
    await expect(
      answerWithContext(context, "Draft a Yes pick", async () => ({
        ...reply,
        evidenceRefs: [],
        proposedPick: { outcome: "Invented", reason: "r" },
      })),
    ).rejects.toThrow("INVALID_PICK_DRAFT");
    const result = await answerWithContext(
      context,
      "Draft a Yes pick",
      async () => ({
        ...reply,
        evidenceRefs: [],
        proposedPick: { outcome: "Yes", reason: "My reviewed reasoning" },
      }),
    );
    expect(result.proposedPick?.outcome).toBe("Yes");
  });
  it("always loads the saved pick even when the model omits its read", async () => {
    const readPick = vi.fn(async () => ({
      userId: "u",
      pickId: "existing",
      market: { platform: "kalshi" as const, nativeId: "TEST" },
      version: 2,
      outcome: "Yes",
      reason: "Existing reason",
    }));
    await expect(
      runResearch(
        {
          userId: "u",
          market,
          message: "Draft",
          history: [],
          now: new Date(),
          domain: "sports",
        },
        {
          plan: async () => ({ tools: [] }),
          generate: async () => ({
            ...reply,
            proposedPick: { outcome: "No", reason: "new" },
          }),
          readPick,
          readLessons: async () => [],
          readComparison: async () => [],
          marketSource: {
            id: "market-source",
            text: "terms",
            retrievedAt: "2026-10-23T00:00:00Z",
            url: "https://kalshi.com",
          },
        },
      ),
    ).rejects.toThrow("INVALID_PICK_DRAFT");
    expect(readPick).toHaveBeenCalledTimes(1);
  });
  it("rejects invented mutation tools before running or generating", async () => {
    expect(readPlanSchema.safeParse({ tools: ["write_pick"] }).success).toBe(
      false,
    );
    const gen = vi.fn();
    await expect(
      runResearch(
        {
          userId: "u",
          market,
          message: "hi",
          history: [],
          now: new Date(),
          domain: "sports",
        },
        {
          plan: async () => ({ tools: ["write_pick"] }),
          generate: gen,
          readPick: async () => null,
          readLessons: async () => [],
          readComparison: async () => [],
          marketSource: {
            id: "market-source",
            text: "terms",
            retrievedAt: "2026-10-23T00:00:00Z",
            url: "https://kalshi.com",
          },
        },
      ),
    ).rejects.toThrow();
    expect(gen).not.toHaveBeenCalled();
  });
  it("fails closed when tool context belongs to another user", async () => {
    await expect(
      runResearch(
        {
          userId: "u",
          market,
          message: "review",
          history: [],
          now: new Date(),
          domain: "sports",
        },
        {
          plan: async () => ({ tools: ["read_saved_pick"] }),
          generate: async () => reply,
          readPick: async () => ({
            userId: "other",
            pickId: "p",
            market: { platform: "kalshi", nativeId: "TEST" },
            version: 1,
            outcome: "Yes",
            reason: "r",
          }),
          readLessons: async () => [],
          readComparison: async () => [],
          marketSource: {
            id: "market-source",
            text: "terms",
            retrievedAt: "2026-10-23T00:00:00Z",
            url: "https://kalshi.com",
          },
        },
      ),
    ).rejects.toThrow("FORBIDDEN_CONTEXT");
  });
});

it("fits large source sets and prior chat within the prompt budget", async () => {
  const result = await runResearch(
    {
      userId: "u",
      market,
      message: "Explain",
      history: [
        { role: "user", text: "a".repeat(12000) },
        { role: "assistant", text: "b".repeat(12000) },
      ],
      domain: "sports",
      now: new Date(),
    },
    {
      plan: async () => ({ tools: [] }),
      generate: async (request) => {
        expect(request.prompt.length).toBeLessThan(60000);
        return reply;
      },
      readPick: async () => null,
      readLessons: async () => [],
      readComparison: async () => [],
      marketSource: {
        id: "market-source",
        text: "terms",
        retrievedAt: new Date().toISOString(),
        url: "https://kalshi.com",
      },
      readIndependent: async () =>
        Array.from({ length: 14 }, (_, i) => ({
          id: `s-${i}`,
          text: '"'.repeat(9500),
          retrievedAt: new Date().toISOString(),
          url: "https://nba.com",
        })),
    },
  );
  expect(result.reply.message).toBe(reply.message);
});
