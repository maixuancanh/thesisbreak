import { describe, expect, it } from "vitest";
import {
  createAgentContext,
  answerWithContext,
  parseLlmConfig,
} from "../../packages/agent/src/context";

const input = {
  userId: "user-a",
  market: {
    platform: "polymarket" as const,
    nativeId: "market-a",
    question: "Will A win?",
    outcomes: ["Yes", "No"],
    rules: "Regular time only",
  },
  pick: {
    userId: "user-a",
    pickId: "pick-a",
    market: { platform: "polymarket" as const, nativeId: "market-a" },
    version: 1,
    outcome: "Yes",
    reason: "Captain starts",
  },
  evidence: [
    {
      userId: "user-a",
      id: "source-a",
      market: { platform: "polymarket" as const, nativeId: "market-a" },
      text: "Captain listed on bench",
      publishedAt: null,
      retrievedAt: "2026-10-22T00:00:00Z",
    },
  ],
  lessons: [],
  now: new Date("2026-10-22T00:00:00Z"),
};
describe("agent authorized context offline", () => {
  it("bounds approved lessons and total prompt before provider use", async () => {
    const lesson = {
      id: "lesson-a",
      userId: "user-a",
      version: 1,
      parentVersion: null,
      rule: "a".repeat(13000),
      scope: { domain: "football" },
      approval: "approved",
      status: "active",
      effectiveAt: "2026-10-01T00:00:00Z",
      expiresAt: null,
      supersededBy: null,
    };
    expect(() =>
      createAgentContext({ ...input, domain: "football", lessons: [lesson] }),
    ).toThrow("LESSON_CONTEXT_TOO_LARGE");
    const context = createAgentContext({
      ...input,
      evidence: Array.from({ length: 10 }, (_, i) => ({
        ...input.evidence[0]!,
        id: `source-${i}`,
        text: "a".repeat(9000),
      })),
    });
    let called = false;
    await expect(
      answerWithContext(context, "Review", async () => {
        called = true;
        return {};
      }),
    ).rejects.toThrow("CONTEXT_TOO_LARGE");
    expect(called).toBe(false);
  });
  it("rejects cross-user resources before generation", () => {
    expect(() =>
      createAgentContext({
        ...input,
        evidence: [{ ...input.evidence[0]!, userId: "user-b" }],
      }),
    ).toThrow("FORBIDDEN_CONTEXT");
    expect(() =>
      createAgentContext({
        ...input,
        pick: { ...input.pick, userId: "user-b" },
      }),
    ).toThrow("FORBIDDEN_CONTEXT");
  });
  it("rejects another market's pick or evidence even for the same user", () => {
    expect(() =>
      createAgentContext({
        ...input,
        pick: {
          ...input.pick,
          market: { platform: "kalshi", nativeId: "market-a" },
        },
      }),
    ).toThrow("MARKET_CONTEXT_MISMATCH");
    expect(() =>
      createAgentContext({
        ...input,
        evidence: [
          {
            ...input.evidence[0]!,
            market: { platform: "polymarket", nativeId: "market-b" },
          },
        ],
      }),
    ).toThrow("MARKET_CONTEXT_MISMATCH");
  });
  it("provides context as untrusted data and returns only reviewable proposals", async () => {
    const context = createAgentContext(input);
    const result = await answerWithContext(
      context,
      "Keep Yes but change reason",
      async (request) => {
        expect(request.system).toContain("untrusted");
        expect(request.system).toContain("never approve");
        expect(request.prompt).toContain("Captain starts");
        return {
          message:
            "The captain assumption changed; the result is still uncertain.",
          evidenceRefs: ["source-a"],
          lessonRefs: [],
          proposedChange: {
            baseVersion: 1,
            outcome: null,
            reason: "Home advantage, despite captain on bench",
          },
        };
      },
    );
    expect(result.proposedChange?.baseVersion).toBe(1);
    expect(input.pick.reason).toBe("Captain starts");
  });
  it("rejects fabricated references, stale proposals and unknown outcomes", async () => {
    for (const changes of [
      { evidenceRefs: ["fake"] },
      { lessonRefs: ["invented"] },
      { proposedChange: { baseVersion: 2, outcome: "Yes", reason: null } },
      {
        proposedChange: {
          baseVersion: 1,
          outcome: "Bet everything",
          reason: null,
        },
      },
    ]) {
      await expect(
        answerWithContext(
          createAgentContext(input),
          "Challenge me",
          async () => ({
            message: "Review this",
            evidenceRefs: [],
            lessonRefs: [],
            proposedChange: null,
            ...changes,
          }),
        ),
      ).rejects.toThrow();
    }
  });
  it("does not invent lesson context when no approved applicable memory was provided", () => {
    const context = createAgentContext({
      ...input,
      lessons: [
        {
          id: "lesson-a",
          userId: "user-a",
          version: 1,
          parentVersion: null,
          rule: "Official only",
          scope: { domain: "politics" },
          approval: "approved",
          status: "active",
          effectiveAt: "2026-10-01T00:00:00Z",
          expiresAt: null,
          supersededBy: null,
        },
      ],
      domain: "football",
    });
    expect(context.lessons).toEqual([]);
  });
  it("requires explicit model settings without accepting credential-bearing or insecure URLs", () => {
    expect(() => parseLlmConfig({})).toThrow("LLM_NOT_CONFIGURED");
    expect(() =>
      parseLlmConfig({
        LLM_API_KEY: "key",
        LLM_MODEL: "model",
        LLM_BASE_URL: "https://key@host.test/v1",
      }),
    ).toThrow();
    expect(() =>
      parseLlmConfig({
        LLM_API_KEY: "key",
        LLM_MODEL: "model",
        LLM_BASE_URL: "http://host.test/v1",
      }),
    ).toThrow();
  });
});
