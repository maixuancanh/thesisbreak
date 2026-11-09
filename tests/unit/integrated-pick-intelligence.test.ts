import { describe, expect, it, vi } from "vitest";
import { checkSettlementRules, compareSettlementRules } from "../../packages/domain/src/settlement-rules";
import { groupPortfolioReasons, type PortfolioPick } from "../../packages/domain/src/portfolio-reasons";
import { buildSourceScore } from "../../packages/domain/src/source-credibility";
import { runResearch } from "../../packages/agent/src/runtime";

const now = new Date("2026-11-07T00:00:00Z");
const pick = (id: string, overrides: Partial<PortfolioPick> = {}): PortfolioPick => ({
  id, version: 2, platform: "kalshi", nativeId: id, question: `Will ${id} win?`, outcome: "Yes",
  reason: "Wait for the official lineup", conditions: [], ...overrides,
});
const condition = {
  kind: "official_lineup", subjectId: "player-1", eventIds: ["event-1"],
  statement: "Player 1 starts", revisitWhen: "Player 1 is absent",
  predicate: { type: "lineup_status", expected: "starter", revisitOn: "not_starter" },
  sourcePolicy: "official_required", validFrom: "2026-11-06T00:00:00Z", validUntil: "2026-11-08T00:00:00Z",
};

describe("integrated pick intelligence", () => {
  it("never treats equal text, binary labels or same titles as market equivalence", () => {
    const market = { platform: "kalshi", eventId: "event", rules: "Terms", closeTime: null, outcomes: [{ name: "Yes" }, { name: "No" }] };
    const different = compareSettlementRules(market, { ...market, rules: "Other terms" });
    expect(different.ruleText).toBe("different");
    const crossPlatform = compareSettlementRules(market, { ...market, platform: "polymarket" });
    expect(crossPlatform.sameEvent).toBe(false);
    expect(crossPlatform.equivalence).toBe("not_established");
    expect(crossPlatform.sameClose).toBe(false);
  });
  it("preserves contradictory overtime wording as quoted text instead of declaring compatibility", () => {
    const rules = "Overtime is included. Extra time is excluded. Abandoned games are void.";
    const result = checkSettlementRules({ rules, sourceUrl: "https://example.com/rules", observedAt: now.toISOString() });
    expect(result.excerpts.filter((e) => e.topic === "overtime").map((e) => e.text)).toEqual(["Overtime is included.", "Extra time is excluded."]);
    expect(result.comparison).toBe("requires_exact_event_outcome_and_rules_review");
    expect(checkSettlementRules({ rules: "The official result is published by the league.", sourceUrl: null, observedAt: now.toISOString() }).excerpts.some((e) => e.topic === "deadline")).toBe(false);
  });
  it("distinguishes missing rules, changed terms and an unknown historical rule body", () => {
    const previous = { rules: "Original terms", pickId: "p1", version: 1, recordedAt: now.toISOString() };
    expect(checkSettlementRules({ rules: null, sourceUrl: null, observedAt: now.toISOString(), previous }).state).toBe("missing");
    expect(checkSettlementRules({ rules: "Revised terms", sourceUrl: null, observedAt: now.toISOString(), previous }).state).toBe("changed");
    expect(checkSettlementRules({ rules: "Terms", sourceUrl: null, observedAt: now.toISOString(), previous: { ...previous, rules: null } }).state).toBe("available");
  });
  it("groups identical saved reasons, preserves negation, and never counts a pick twice", () => {
    const groups = groupPortfolioReasons([pick("1"), pick("2"), pick("3", { reason: "Do not wait for the official lineup" })], now);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.picks.map((p) => p.id)).toEqual(["1", "2"]);
  });
  it("matches typed conditions across different reasons but rejects different events, predicates and expired conditions", () => {
    const groups = groupPortfolioReasons([
      pick("1", { reason: "First view", conditions: [condition] }),
      pick("2", { reason: "Another view", conditions: [condition] }),
      pick("3", { reason: "Other event", conditions: [{ ...condition, eventIds: ["event-2"] }] }),
      pick("4", { reason: "Expired", conditions: [{ ...condition, validUntil: now.toISOString() }] }),
      pick("5", { reason: "Available is different", conditions: [{ ...condition, predicate: { ...condition.predicate, expected: "available" } }] }),
    ], now);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("same_condition");
    expect(groups[0]?.picks.map((p) => p.id)).toEqual(["1", "2"]);
  });
  it("passes checks to planning and generation, and enforces snapshot and independent checks even when omitted by the model", async () => {
    const checks = {
      rules: checkSettlementRules({ rules: "Current", sourceUrl: "https://example.com", observedAt: now.toISOString(), previous: { rules: "Old", pickId: "1", version: 1, recordedAt: now.toISOString() } }),
      connections: groupPortfolioReasons([pick("1", { conditions: [condition] }), pick("2", { conditions: [condition] })], now).filter((g) => g.kind === "same_condition"),
      connectionsState: "checked" as const, scannedPicks: 2, contextOnly: true as const,
    };
    const comparison = vi.fn(async () => []), independent = vi.fn(async () => []);
    await runResearch({ userId: "u", market: { platform: "kalshi", nativeId: "1", question: "First wins?", outcomes: ["Yes", "No"], rules: "Current" }, message: "Review my pick", history: [], domain: "sports", now }, {
      decisionChecks: checks,
      plan: async (input) => { expect(input.decisionChecks).toEqual(checks); return { tools: [] }; },
      generate: async (input) => {
        expect(JSON.parse(input.prompt).context.decisionChecks).toEqual(checks);
        return { message: "Rules changed; check both linked picks.", evidenceRefs: ["market-source"], lessonRefs: [], proposedChange: null };
      },
      readPick: async () => null, readLessons: async () => [], readComparison: comparison, readIndependent: independent,
      marketSource: { id: "market-source", url: "https://example.com", text: "Current", retrievedAt: now.toISOString() },
    });
    expect(comparison).toHaveBeenCalledOnce();
    expect(independent).toHaveBeenCalledOnce();
  });
  it("a recalled source history triggers corroboration while keeping zero samples visible", async () => {
    const source = buildSourceScore({ id: "s", userId: "u", sourceId: "s", sourceName: "Example", kind: "user_reported_forecaster", cohort: "sports:general", version: 1, updatedAt: now.toISOString(), forecasts: [] });
    const independent = vi.fn(async () => []);
    await runResearch({ userId: "u", market: { platform: "kalshi", nativeId: "1", question: "First wins?", outcomes: ["Yes", "No"], rules: "Current" }, message: "Can I rely on Example?", history: [], domain: "sports", now }, {
      decisionChecks: { rules: checkSettlementRules({ rules: "Current", sourceUrl: null, observedAt: now.toISOString() }), connections: [], connectionsState: "checked", scannedPicks: 0, contextOnly: true },
      plan: async (input) => { expect(input.sourceMemories).toHaveLength(1); return { tools: [] }; },
      generate: async (input) => { expect(JSON.parse(input.prompt).context.sourceMemories[0].performance.scored).toBe(0); return { message: "No completed history yet.", evidenceRefs: ["market-source"], lessonRefs: [], proposedChange: null }; },
      readSourceMemories: async () => [source], readPick: async () => null, readLessons: async () => [], readComparison: async () => [], readIndependent: independent,
      marketSource: { id: "market-source", url: "https://example.com", text: "Current", retrievedAt: now.toISOString() },
    });
    expect(independent).toHaveBeenCalledOnce();
  });
});
