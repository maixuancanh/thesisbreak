import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { memoryBenchmarkCaseSchema } from "../../packages/domain/src/memory-benchmark";
import {
  ablationOrder,
  runRuntimeAblations,
} from "../../packages/agent/src/runtime-ablation";
const fixture = memoryBenchmarkCaseSchema.parse(
  JSON.parse(
    readFileSync("tests/fixtures/agent-memory/cases.jsonl", "utf8").split(
      "\n",
    )[0]!,
  ),
);
it("drives four arms through actual runtime and rejects foreign/revoked/future memory before planning", async () => {
  const plan = vi.fn(async () => ({ tools: [] })),
    generate = vi.fn(async () => ({
      message: "Current evidence is unavailable.",
      evidenceRefs: [],
      lessonRefs: [],
      proposedPick: null,
      proposedChange: null,
    }));
  const recall = vi.fn(async () => structuredClone(fixture.memories)),
    traces: unknown[] = [];
  const result = await runRuntimeAblations({
    fixture,
    seed: "v1",
    modelVersion: "injected-test",
    plan,
    generate,
    recall,
    memoryTransport: "frozen_synthetic",
    onTrace: async (t) => {
      traces.push(t);
    },
  });
  expect(result.attempts).toBe(4);
  expect(result.failures).toBe(0);
  expect(recall).toHaveBeenCalledTimes(3);
  expect(plan).toHaveBeenCalledTimes(4);
  expect(generate).toHaveBeenCalledTimes(4);
  const current = result.traces.find((t) => t.arm === "current_memory")!;
  expect(current.retrieved.map((m) => m.id)).toEqual([fixture.expected[0]!.id]);
  expect(current.rejected.map((m) => m.reason)).toEqual(
    expect.arrayContaining([
      "wrong_owner",
      "revoked",
      "future_memory",
      "wrong_event",
    ]),
  );
  expect(
    result.traces.every((t) => t.mutations === 0 && t.maxCalls === 2),
  ).toBe(true);
  expect(ablationOrder(fixture.id, "v1")).toEqual(
    ablationOrder(fixture.id, "v1"),
  );
  expect(traces).toHaveLength(4);
});
it("retains recall failures rather than presenting an empty successful memory arm", async () => {
  const result = await runRuntimeAblations({
    fixture,
    seed: "v2",
    modelVersion: "injected",
    plan: async () => ({ tools: [] }),
    generate: async () => ({
      message: "Unknown",
      evidenceRefs: [],
      lessonRefs: [],
      proposedPick: null,
      proposedChange: null,
    }),
    recall: async () => {
      throw Error("offline");
    },
    memoryTransport: "fresh_verified_walrus",
    onTrace: async () => {},
  });
  expect(result.failures).toBe(3);
  expect(result.groundingImprovementConfirmed).toBe(false);
});

it("pairs current recap lesson and control with identical current evidence and budgets", async () => {
  const row = JSON.parse(
    readFileSync(
      "tests/fixtures/pick-review/memory-pair-cases.jsonl",
      "utf8",
    ).split("\n")[0]!,
  );
  const plans: { lessons: unknown[]; requiredConditions: unknown[] }[] = [];
  const result = await runRuntimeAblations({
    fixture: row.fixture,
    seed: "pair",
    modelVersion: "injected-test",
    arms: ["current_memory", "no_memory"],
    currentEvidence: {
      marketSource: {
        id: "market",
        kind: "market",
        text: "Synthetic market",
        url: "https://example.invalid/market",
        retrievedAt: row.fixture.knownAt,
      },
      independent: [
        {
          id: "rumor",
          kind: "background",
          text: "Synthetic rumor, no official lineup.",
          url: "https://example.invalid/rumor",
          retrievedAt: row.fixture.knownAt,
          confirmsLineup: false,
        },
      ],
    },
    lessonsForMemories: (accepted) => (accepted.length ? [row.lesson] : []),
    plan: async (request) => {
      plans.push({
        lessons: request.lessons ?? [],
        requiredConditions: request.requiredConditions ?? [],
      });
      return { tools: [] };
    },
    generate: async () => ({
      message: "The official lineup still needs checking.",
      evidenceRefs: [],
      lessonRefs: [],
      proposedPick: null,
      proposedChange: null,
    }),
    recall: async () => row.fixture.memories,
    memoryTransport: "frozen_synthetic",
    onTrace: async () => {},
  });
  expect(result.attempts).toBe(2);
  expect(result.failures).toBe(0);
  expect(new Set(result.traces.map((t) => t.evidenceHash)).size).toBe(1);
  expect(new Set(result.traces.map((t) => t.questionHash)).size).toBe(1);
  expect(result.traces.every((t) => t.calls === 2 && t.maxCalls === 2)).toBe(
    true,
  );
  expect(
    plans.some(
      (p) => p.lessons.length === 1 && p.requiredConditions.length === 1,
    ),
  ).toBe(true);
  expect(
    plans.some(
      (p) => p.lessons.length === 0 && p.requiredConditions.length === 0,
    ),
  ).toBe(true);
  const memory = result.traces.find((t) => t.arm === "current_memory")!;
  expect(
    memory.toolTrace.some((t) => t.tool === "read_independent_sources"),
  ).toBe(true);
});

it.each(["2027-01-01T00:00:00Z", "invalid", ""])(
  "rejects an unavailable market cutoff timestamp (%s) before model calls",
  async (retrievedAt) => {
    const plan = vi.fn(async () => ({ tools: [] }));
    const generate = vi.fn(async () => ({
      message: "Unknown",
      evidenceRefs: [],
      lessonRefs: [],
      proposedPick: null,
      proposedChange: null,
    }));
    const report = await runRuntimeAblations({
      fixture,
      seed: "market-cutoff",
      modelVersion: "injected",
      plan,
      generate,
      currentEvidence: {
        marketSource: {
          id: "bad-market",
          text: "future",
          url: "https://example.invalid/market",
          retrievedAt,
        },
        independent: [],
      },
      recall: async () => fixture.memories,
      memoryTransport: "frozen_synthetic",
      onTrace: async () => {},
    });
    expect(report.failures).toBe(4);
    expect(plan).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(
      report.traces.every((trace) =>
        trace.raw.some(
          (entry) =>
            (entry as { stage: string }).stage === "rejected_current_evidence",
        ),
      ),
    ).toBe(true);
  },
);

it("excludes future or invalid independent evidence timestamps before model exposure and preserves rejected diagnostics", async () => {
  const generate = vi.fn(async () => ({
    message: "Unknown",
    evidenceRefs: [],
    lessonRefs: [],
    proposedPick: null,
    proposedChange: null,
  }));
  const report = await runRuntimeAblations({
    fixture,
    seed: "independent-cutoff",
    modelVersion: "injected",
    plan: async () => ({ tools: ["read_independent_sources"] }),
    generate,
    currentEvidence: {
      marketSource: {
        id: "market",
        text: "Synthetic market",
        url: "https://example.invalid/market",
        retrievedAt: fixture.knownAt,
      },
      independent: [
        {
          id: "future-retrieved",
          text: "FUTURE_RETRIEVED_OBSERVATION",
          url: "https://example.invalid/future",
          retrievedAt: "2027-01-01T00:00:00Z",
        },
        {
          id: "future-published",
          text: "FUTURE_PUBLISHED_OBSERVATION",
          url: "https://example.invalid/future",
          retrievedAt: fixture.knownAt,
          publishedAt: "2027-01-01T00:00:00Z",
        },
        {
          id: "invalid-retrieved",
          text: "INVALID_TIMESTAMP_OBSERVATION",
          url: "https://example.invalid/future",
          retrievedAt: "invalid",
        },
        {
          id: "unknown-published",
          text: "UNKNOWN_TIMESTAMP_OBSERVATION",
          url: "https://example.invalid/future",
          retrievedAt: fixture.knownAt,
          publishedAt: null,
        },
        {
          id: "valid",
          text: "VALID_SYNTHETIC_OBSERVATION",
          url: "https://example.invalid/valid",
          retrievedAt: fixture.knownAt,
        },
        {
          id: "future-quote",
          text: "FUTURE_QUOTE_OBSERVATION",
          url: "https://example.invalid/quote",
          retrievedAt: fixture.knownAt,
          quoteObservedAt: "2027-01-01T00:00:00Z",
        },
        {
          id: "future-history",
          text: "FUTURE_HISTORY_OBSERVATION",
          url: "https://example.invalid/history",
          retrievedAt: fixture.knownAt,
          historicalKnownAt: "2027-01-01T00:00:00Z",
        },
      ],
    },
    recall: async () => fixture.memories,
    memoryTransport: "frozen_synthetic",
    onTrace: async () => {},
  });
  expect(report.failures).toBe(0);
  expect(JSON.stringify(generate.mock.calls)).toContain(
    "VALID_SYNTHETIC_OBSERVATION",
  );
  for (const marker of [
    "FUTURE_RETRIEVED_OBSERVATION",
    "FUTURE_PUBLISHED_OBSERVATION",
    "INVALID_TIMESTAMP_OBSERVATION",
    "UNKNOWN_TIMESTAMP_OBSERVATION",
    "FUTURE_QUOTE_OBSERVATION",
    "FUTURE_HISTORY_OBSERVATION",
  ])
    expect(JSON.stringify(generate.mock.calls)).not.toContain(marker);
  expect(
    report.traces.every(
      (trace) =>
        (trace as unknown as { rejectedEvidence: unknown[] }).rejectedEvidence
          .length === 6,
    ),
  ).toBe(true);
});
