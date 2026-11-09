import { expect, it, vi } from "vitest";
import {
  applyResearchMemoryPolicy,
  researchActionAudit,
} from "../../packages/agent/src/memory-policy";
import { runResearch } from "../../packages/agent/src/runtime";
const scope = { league: "NBA", market: "winner", horizon: "T60m" };
const memory = {
  userId: "u",
  forecastId: "f",
  capturedAt: "2026-10-01T00:00:00Z",
  forecast: {
    scheduledAt: "2026-10-01T01:00:00Z",
    modelConfig: {
      memoryPolicy: {
        version: "forecast-validity-v1",
        scope,
        regime: "NBA-season-2026",
        expiresAt: "2026-10-31T00:00:00Z",
      },
    },
  },
};
const base = {
  userId: "u",
  now: new Date("2026-10-20T00:00:00Z"),
  requestedScope: scope,
  currentRegime: "NBA-season-2026",
  sourceMemories: [],
  forecastMemories: [memory],
};
it("excludes expired, foreign, scope-mismatched and changed-regime predictive history", () => {
  expect(applyResearchMemoryPolicy(base).forecastMemories).toHaveLength(1);
  expect(
    applyResearchMemoryPolicy({
      ...base,
      now: new Date("2026-11-01T00:00:00Z"),
    }).memoryDecisions[0]?.reasons,
  ).toContain("expired");
  expect(
    applyResearchMemoryPolicy({ ...base, currentRegime: "NBA-season-2027" })
      .forecastMemories,
  ).toEqual([]);
  expect(
    applyResearchMemoryPolicy({
      ...base,
      requestedScope: { ...scope, horizon: "T24h" },
    }).forecastMemories,
  ).toEqual([]);
  expect(
    applyResearchMemoryPolicy({ ...base, userId: "other" }).forecastMemories,
  ).toEqual([]);
});
it("does not invent predictive validity or action usefulness", () => {
  const { currentRegime, ...unknown } = base;
  void currentRegime;
  const policy = applyResearchMemoryPolicy(unknown);
  expect(policy.memoryDecisions[0]?.role).toBe("historical_context_only");
  expect(
    researchActionAudit(
      { action: "waited", evidenceRefs: [], proposalWithheld: true },
      policy,
    ),
  ).toMatchObject({ improvementSupported: false, evidenceLevel: "unmeasured" });
});
it("filters history before planning and withholds a change when required lineup is absent", async () => {
  const plan = vi.fn(async (input) => {
    expect(input.sourceMemories).toEqual([]);
    return { tools: [] };
  });
  const market = {
    platform: "kalshi" as const,
    nativeId: "KXNBAGAME-X",
    question: "Home wins?",
    outcomes: ["Yes", "No"],
    rules: "Winner",
  };
  const result = await runResearch(
    {
      userId: "u",
      market,
      message: "Should I change?",
      history: [],
      domain: "sports",
      now: base.now,
      requestedScope: scope,
      currentRegime: "NBA-season-2027",
      researchPrerequisites: {
        requiresLineup: true,
        confirmedLineupEvidenceRefs: [],
        conflictingEvidence: false,
      },
    },
    {
      plan,
      generate: async () => ({
        message: "Wait for starters.",
        evidenceRefs: ["market-source"],
        lessonRefs: [],
        proposedChange: {
          baseVersion: 1,
          outcome: "No",
          reason: "Unconfirmed lineup",
        },
      }),
      readPick: async () => ({
        userId: "u",
        pickId: "p",
        market: { platform: "kalshi", nativeId: market.nativeId },
        version: 1,
        outcome: "Yes",
        reason: "Starter plays",
      }),
      readLessons: async () => [],
      readForecastMemories: async () => [memory],
      readComparison: async () => [],
      marketSource: {
        id: "market-source",
        url: "https://kalshi.com",
        text: "Market",
        retrievedAt: base.now.toISOString(),
        publishedAt: base.now.toISOString(),
        kind: "market",
      },
    },
  );
  expect(result.reply.proposedChange).toBeNull();
  expect(result.researchAudit).toMatchObject({
    action: "waited",
    proposalWithheld: true,
    improvementSupported: false,
  });
});
