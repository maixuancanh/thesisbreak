import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { actionBenchmarkCaseSchema } from "../../packages/domain/src/action-benchmark";
import { runActionRuntimeAblations } from "../../packages/agent/src/action-runtime-ablation";
import { createExactActionRecall } from "../../packages/agent/src/action-evaluation-walrus";
import type { MemwalAdapter } from "../../packages/integrations/src/memwal";
const corpus = readFileSync("tests/fixtures/agent-actions/cases.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => actionBenchmarkCaseSchema.parse(JSON.parse(line)));
const reply = async () => ({
  message: "Review needed.",
  evidenceRefs: [],
  lessonRefs: [],
  proposedPick: null,
  proposedChange: null,
});

it("executes all 40 synthetic fixtures in four matched runtime arms without assuming gold calls ran", async () => {
  expect(corpus).toHaveLength(40);
  let attempts = 0;
  for (const fixture of corpus) {
    const plan = vi.fn(async () => ({ tools: [] }));
    const report = await runActionRuntimeAblations({
      fixture,
      seed: "all",
      modelVersion: "injected-test",
      plan,
      generate: reply,
      onTrace: async () => {},
    });
    expect(report.attempts).toBe(4);
    expect(report.failures).toBe(0);
    expect(plan).toHaveBeenCalledTimes(4);
    expect(new Set(report.traces.map((t) => t.questionHash)).size).toBe(1);
    expect(new Set(report.traces.map((t) => t.evidenceHash)).size).toBe(1);
    expect(
      report.traces.every(
        (t) => t.calls === 2 && t.dataMode === "synthetic" && t.mutations === 0,
      ),
    ).toBe(true);
    for (const trace of report.traces) {
      expect(
        trace.toolEvidence.every((t) =>
          trace.toolTrace.some((actual) => actual.tool === t.tool),
        ),
      ).toBe(true);
      if (
        fixture.requiredTools.some(
          (tool) => !trace.toolEvidence.some((row) => row.tool === tool),
        )
      )
        expect(trace.score.passed).toBe(false);
    }
    attempts += report.denominator;
  }
  expect(attempts).toBe(160);
});

it("scores only actual executed fixture evidence and retains raw calls", async () => {
  const fixture = corpus[0]!;
  const report = await runActionRuntimeAblations({
    fixture,
    seed: "reads",
    modelVersion: "injected",
    plan: async () => ({ tools: ["read_independent_sources"] }),
    generate: reply,
    onTrace: async () => {},
  });
  expect(
    report.traces.every((t) =>
      t.toolEvidence.some((r) => r.tool === "read_independent_sources"),
    ),
  ).toBe(true);
  expect(
    report.traces.every((t) =>
      t.raw.some((r) => (r as { stage: string }).stage === "generate_response"),
    ),
  ).toBe(true);
  expect(report.traces.filter((t) => t.acceptedMemory)).toHaveLength(1);
});

it("does not silently replace failed remote recall with local fixture memory", async () => {
  const plan = vi.fn(async () => ({ tools: [] }));
  const recallExact = vi.fn(async () => {
    throw Error("remote unavailable with private details");
  });
  const report = await runActionRuntimeAblations({
    fixture: corpus[0]!,
    seed: "failed",
    modelVersion: "injected",
    memoryTransport: "fresh_verified_walrus",
    recallExact,
    plan,
    generate: reply,
    onTrace: async () => {},
  });
  expect(report.denominator).toBe(4);
  expect(report.failures).toBe(3);
  expect(recallExact).toHaveBeenCalledTimes(3);
  expect(plan).toHaveBeenCalledTimes(1);
  expect(report.traces.every((t) => !t.acceptedMemory)).toBe(true);
  expect(JSON.stringify(report)).not.toContain("private details");
});

it("retains model failures in the denominator", async () => {
  const report = await runActionRuntimeAblations({
    fixture: corpus[0]!,
    seed: "failed",
    modelVersion: "injected",
    plan: async () => {
      throw Error("failed");
    },
    generate: reply,
    onTrace: async () => {},
  });
  expect(report.failures).toBe(4);
  expect(report.passed).toBe(0);
  expect(report.denominator).toBe(4);
});

it("rejects production identity mixed with a synthetic owner before DB or remote reads", async () => {
  const query = vi.fn();
  const adapterForOwner = vi.fn();
  const recall = createExactActionRecall({
    pool: { query },
    adapterForOwner,
    manifest: {
      purpose: "authorized_synthetic_action_evaluation",
      records: [
        {
          fixtureId: corpus[0]!.id,
          namespace: corpus[0]!.namespace,
          ownerId: "production-owner",
          sessionId: "00000000-0000-4000-8000-000000000001",
          version: 1,
          walrusNamespace: "wrong",
          blobId: "blob",
          hash: "a".repeat(64),
        },
      ],
    },
  });
  await expect(recall(corpus[0]!)).rejects.toThrow(
    "EVALUATION_OWNER_NAMESPACE_MISMATCH",
  );
  expect(query).not.toHaveBeenCalled();
  expect(adapterForOwner).not.toHaveBeenCalled();
});

it("requires matching fresh remote bytes and rechecks current consent after recall", async () => {
  const fixture = corpus[0]!;
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const payload = {
    sessionId,
    title: "Explicit synthetic evaluation",
    turns: [
      {
        runId: "eval-run",
        platform: "kalshi",
        nativeId: fixture.marketId,
        question: fixture.query,
        user: fixture.memory,
        reply: "",
        at: fixture.cutoffAt,
        evidenceRefs: [],
      },
    ],
  };
  const owned = {
    payload,
    blob_id: "exact-blob",
    hash: "a".repeat(64),
    recorded_at: fixture.cutoffAt,
  };
  const query = vi.fn().mockResolvedValue({ rows: [owned] });
  const recallRecord = vi.fn(async (record: unknown) => ({
    sources: [
      {
        blobId: "exact-blob",
        record: {
          ...(record as object),
          hash: owned.hash,
        },
      },
    ],
    conflicts: [],
  }));
  const adapter = {
    namespace: "exact-namespace",
    recallRecord,
  } as unknown as MemwalAdapter;
  const recall = createExactActionRecall({
    pool: { query },
    adapterForOwner: () => adapter,
    manifest: {
      purpose: "authorized_synthetic_action_evaluation",
      records: [
        {
          fixtureId: fixture.id,
          ownerId: fixture.ownerId,
          namespace: fixture.namespace,
          sessionId,
          version: 1,
          walrusNamespace: adapter.namespace,
          blobId: owned.blob_id,
          hash: owned.hash,
        },
      ],
    },
  });
  expect((await recall(fixture)).text).toBe(fixture.memory);
  expect(recallRecord).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledTimes(2);
  query
    .mockReset()
    .mockResolvedValueOnce({ rows: [owned] })
    .mockResolvedValueOnce({ rows: [] });
  await expect(recall(fixture)).rejects.toThrow(
    "AUTHORITY_CHANGED_DURING_RECALL",
  );
  query.mockReset().mockResolvedValue({ rows: [owned] });
  recallRecord.mockResolvedValueOnce({ sources: [], conflicts: [] });
  await expect(recall(fixture)).rejects.toThrow("EXACT_REMOTE_BYTES_REQUIRED");
});

it("does not score a completed saved-pick check when the runtime receives null", async () => {
  const fixture = corpus.find(
    (row) => row.category === "multi_market_missing",
  )!;
  const report = await runActionRuntimeAblations({
    fixture,
    seed: "null-pick",
    modelVersion: "injected",
    plan: async () => ({ tools: ["compare_snapshot"] }),
    generate: reply,
    onTrace: async () => {},
  });
  for (const trace of report.traces) {
    expect(
      trace.toolEvidence
        .filter((row) => row.tool === "read_saved_pick")
        .every((row) => row.status === "unavailable"),
    ).toBe(true);
    expect(trace.score.missingTools).toContain("read_saved_pick");
    expect(trace.score.passed).toBe(false);
    expect(
      trace.toolTrace.find((row) => row.tool === "read_saved_pick")?.count,
    ).toBe(0);
  }
});

it("rejects future fixture observations before they enter a model request", async () => {
  const fixture = structuredClone(corpus[0]!);
  fixture.goldTools[0]!.availableAt = "2026-11-01T18:01:00Z";
  fixture.goldTools[0]!.evidenceIds = [
    "FUTURE_OBSERVATION_MUST_NOT_REACH_MODEL",
  ];
  const generate = vi.fn(reply);
  const report = await runActionRuntimeAblations({
    fixture,
    seed: "future",
    modelVersion: "injected",
    plan: async () => ({ tools: ["read_independent_sources"] }),
    generate,
    onTrace: async () => {},
  });
  expect(JSON.stringify(generate.mock.calls)).not.toContain(
    "FUTURE_OBSERVATION_MUST_NOT_REACH_MODEL",
  );
  for (const trace of report.traces) {
    expect(
      (trace as unknown as { rejectedEvidence: { reason: string }[] })
        .rejectedEvidence,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "future_evidence" }),
      ]),
    );
    expect(trace.score.missingTools).toContain("read_independent_sources");
  }
});

it.each(["read_tatum_quote", "read_tatum_history", "compare_snapshot"])(
  "scores only the one source consumed for %s",
  async (tool) => {
    const fixture = structuredClone(corpus[0]!);
    fixture.requiredTools = [tool];
    fixture.goldTools = [
      {
        ...fixture.goldTools[0]!,
        tool,
        id: "first",
        evidenceIds: ["consumed-source"],
      },
      {
        ...fixture.goldTools[0]!,
        tool,
        id: "discarded",
        evidenceIds: ["UNCONSUMED_SOURCE"],
      },
    ];
    const generate = vi.fn(reply);
    const report = await runActionRuntimeAblations({
      fixture,
      seed: "limits",
      modelVersion: "injected",
      plan: async () => ({ tools: [tool] }),
      generate,
      onTrace: async () => {},
    });
    expect(JSON.stringify(generate.mock.calls)).not.toContain(
      "UNCONSUMED_SOURCE",
    );
    for (const trace of report.traces) {
      expect(
        trace.toolEvidence.filter((row) => row.tool === tool),
      ).toHaveLength(1);
      expect(trace.toolTrace.find((row) => row.tool === tool)?.count).toBe(1);
      expect(
        (trace as unknown as { rejectedEvidence: { reason: string }[] })
          .rejectedEvidence,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: "runtime_source_limit" }),
        ]),
      );
    }
  },
);
