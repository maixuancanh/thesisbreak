import { describe, expect, it, vi } from "vitest";
import { runResearch } from "../../packages/agent/src/runtime";
const input = {
  userId: "u",
  market: {
    platform: "kalshi" as const,
    nativeId: "TEST",
    question: "A wins?",
    outcomes: ["Yes", "No"],
    rules: "official",
  },
  message: "Challenge my view",
  history: [],
  domain: "Sports",
  now: new Date("2026-10-30T00:00:00Z"),
};
const reply = {
  message: "Draft",
  evidenceRefs: ["market-source"],
  lessonRefs: [],
  proposedChange: null,
  proposedPick: { outcome: "Yes", reason: "my view" },
};
const base = {
  plan: async () => ({ tools: [] }),
  generate: async () => reply,
  readPick: async () => null,
  readLessons: async () => [],
  readComparison: async () => [],
  marketSource: {
    id: "market-source",
    text: "terms",
    retrievedAt: input.now.toISOString(),
    url: "https://kalshi.com",
    canonicalOriginId: "official",
    provenanceRefs: ["official-publication"],
  },
};
describe("opt-in runtime debate", () => {
  it("artifact recall changes actual tool execution and withholds on missing evidence", async () => {
    const plan = vi.fn(async () => ({ tools: [] }));
    const compare = vi.fn(async () => []);
    const result = await runResearch(input, {
      ...base,
      plan,
      readComparison: compare,
      readResearchArtifacts: async () => [
        {
          logicalId: "research:source_change:a",
          version: 1,
          hash: "a".repeat(64),
          blobId: "b",
          check: "recheck_changed_source_dependency",
          causalBenefit: "not_measured",
        },
      ],
    });
    expect(compare).toHaveBeenCalledOnce();
    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({
        researchArtifacts: expect.arrayContaining([
          expect.objectContaining({ blobId: "b" }),
        ]),
      }),
    );
    expect(result.policyRequiredTools).toContain("read_independent_sources");
    expect(result.reply.proposedPick).toBeNull();
    expect(result.researchAudit.proposalWithheld).toBe(true);
  });
  it("keeps default runtime behavior and makes no unreserved calls", async () => {
    const baseline = await runResearch(input, base);
    expect(baseline.evidenceDebate).toBeUndefined();
    const invoke = vi.fn(async () => {
      throw Error("not budgeted");
    });
    const result = await runResearch(input, {
      ...base,
      evidenceDebate: {
        trigger: "explicit_challenge",
        reserveCalls: () => false,
        invoke,
        maxOutputTokens: 600,
      },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.reply).toEqual(baseline.reply);
    expect(result.evidenceDebate?.status).toBe("skipped");
  });
  it("withholds a proposal on failed debate without changing any pick state", async () => {
    const baseline = await runResearch(input, base);
    const result = await runResearch(input, {
      ...base,
      evidenceDebate: {
        trigger: "explicit_challenge",
        reserveCalls: () => true,
        invoke: async () => {
          throw Error("timeout");
        },
        maxOutputTokens: 600,
      },
    });
    expect(result.evidenceDebate?.status).toBe("partial");
    expect(result.reply.proposedPick).toBeNull();
    expect(result.pick).toEqual(baseline.pick);
    expect(result.researchAudit.proposalWithheld).toBe(true);
  });
});
