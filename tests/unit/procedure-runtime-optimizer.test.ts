import { expect, it, vi } from "vitest";
import {
  evaluateProcedureRuntimeCase,
  ProcedureRuntimeBudget,
  procedureRuntimeInputSchema,
  runProcedureRuntimeOptimization,
} from "../../packages/agent/src/procedure-runtime-optimizer";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const candidate = {
  researchInstructions: "Check official sources before drafting.",
};
const fixture = {
  id: "case",
  split: "development",
  optimizerConsent: true,
  message: "Review current official event evidence",
  domain: "sports",
  frozenAt: "2026-11-01T00:00:00Z",
  market: {
    platform: "kalshi",
    nativeId: "test",
    question: "A wins?",
    outcomes: ["Yes", "No"],
    rules: "Official result",
  },
  marketSource: {
    id: "market-source",
    text: "market rules",
    url: "https://example.com",
    retrievedAt: "2026-11-01T00:00:00Z",
    publishedAt: "2026-10-31T00:00:00Z",
    kind: "market",
  },
  independent: [
    {
      id: "official",
      text: "Official event report",
      url: "https://example.com/report",
      retrievedAt: "2026-11-01T00:00:00Z",
      publishedAt: "2026-10-31T00:00:00Z",
      kind: "official_event",
    },
  ],
  expectedTools: ["read_independent_sources"],
  requiredEvidenceIds: ["official"],
};
const request = () => ({
  ownerId: "owner",
  reviewerId: "reviewer",
  optimizerConsent: true,
  corpusVersion: "synthetic-v1",
  mode: "synthetic",
  modelVersion: "test-model",
  seed: candidate,
  maxCandidates: 2,
  maxCalls: 10,
  maxOutputTokens: 20000,
  deadlineSeconds: 120,
  cases: [fixture],
});

it("executes the actual read-only runtime and scores real selected tools/citations", async () => {
  const data = procedureRuntimeInputSchema.parse(request());
  const budget = new ProcedureRuntimeBudget(10, 20000, 120000);
  const plan = vi.fn(async () => ({ tools: ["read_independent_sources"] }));
  const generate = vi.fn(async () => ({
    message: "Official report checked.",
    evidenceRefs: ["official"],
    lessonRefs: [],
    proposedPick: null,
    proposedChange: null,
  }));
  const result = await evaluateProcedureRuntimeCase(
    data,
    data.cases[0]!,
    candidate,
    { plan, generate },
    budget,
  );
  expect(result.action).toBe(1);
  expect(result.grounding).toBe(1);
  expect(result.trace).toBeDefined();
  expect(result.violations).toEqual([]);
  expect(budget.calls).toBe(2);
  expect(generate.mock.calls).toHaveLength(1);
  expect(result.costKnown).toBe(false);
});
it("retains failed model attempts and prevents any call after budget exhaustion", async () => {
  const data = procedureRuntimeInputSchema.parse(request());
  const plan = vi.fn(async () => {
    throw Error("provider failed private details");
  });
  const generate = vi.fn(async () => {
    throw Error("provider failed");
  });
  const result = await evaluateProcedureRuntimeCase(
    data,
    data.cases[0]!,
    candidate,
    { plan, generate },
    new ProcedureRuntimeBudget(0, 0, 120000),
  );
  expect(plan).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(result.violations).toContain("BUDGET_EXCEEDED");
  expect(result.raw).toBeDefined();
});
it("rejects future snapshots, optimizer policy mutations and same-person reviewers", () => {
  for (const patch of [
    { reviewerId: "owner" },
    { seed: { confirmation: "disabled" } },
    { cases: [{ ...fixture, frozenAt: "2026-10-30T00:00:00Z" }] },
    { cases: [{ ...fixture, split: "sealed" }] },
  ]) {
    expect(() =>
      procedureRuntimeInputSchema.parse({ ...request(), ...patch }),
    ).toThrow();
  }
});
it("requires live-model opt-in before initializing any provider or child process", async () => {
  await expect(
    runProcedureRuntimeOptimization({
      request: request(),
      python: "missing",
      workerCwd: "missing",
      liveModel: false,
      env: {},
      onArtifact: async () => {},
    }),
  ).rejects.toThrow("LIVE_MODEL_OPT_IN_REQUIRED");
});
it.skipIf(!existsSync(resolve("workers/research/.venv/Scripts/python.exe")))(
  "runs actual GEPA over paired frozen agent-runtime cases with injected model responses",
  async () => {
    const artifacts: unknown[] = [];
    let proposals = 0;
    const data = request();
    const result = await runProcedureRuntimeOptimization({
      request: data,
      python: resolve("workers/research/.venv/Scripts/python.exe"),
      workerCwd: resolve("workers/research"),
      liveModel: true,
      env: {
        LLM_MODEL: "test-model",
        LLM_API_KEY: "test-only",
        LLM_BASE_URL: "https://example.com/v1",
      },
      onArtifact: async (value) => {
        artifacts.push(value);
      },
      bindings: (candidate) => ({
        plan: async () => ({
          tools: candidate.researchInstructions?.includes("improved")
            ? ["read_independent_sources"]
            : [],
        }),
        generate: async () => ({
          message: "Read-only evaluation",
          evidenceRefs: candidate.researchInstructions?.includes("improved")
            ? ["official"]
            : ["market-source"],
          lessonRefs: [],
          proposedPick: null,
          proposedChange: null,
        }),
      }),
      propose: async () => {
        proposals++;
        return {
          researchInstructions: "improved: read independent official evidence",
        };
      },
    });
    expect(result.method).toBe("gepa.read_only_agent_runtime");
    expect(result.validationPassed).toBe(false);
    expect(result.sealedTestPassed).toBe(false);
    expect(proposals).toBe(1);
    expect(artifacts.length).toBeGreaterThan(2);
    expect(result.actualReservedCalls).toBeLessThanOrEqual(data.maxCalls);
    expect(result.costUsd).toBeNull();
    expect(result.selectedCandidate.researchInstructions).toContain("improved");
    const evaluations = artifacts.filter(
      (a): a is { kind: string; result: { frozenInputHash: string } } =>
        typeof a === "object" &&
        a !== null &&
        "kind" in a &&
        a.kind === "evaluation",
    );
    expect(new Set(evaluations.map((a) => a.result.frozenInputHash)).size).toBe(
      1,
    );
  },
  15000,
);
