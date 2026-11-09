import { expect, it } from "vitest";
import {
  researchInputSchema,
  researchRequest,
  optimizerCandidateHash,
} from "../../packages/db/src/research-inputs";
import {
  researchSchedulerConfig,
  runResearchBatch,
} from "../../packages/integrations/src/research-scheduler";

it("requires paired calibration labels and bounded finite probabilities", () => {
  expect(() =>
    researchInputSchema.parse({
      operation: "calibration",
      payload: { probabilities: [0.2], labels: [] },
    }),
  ).toThrow();
  expect(() =>
    researchInputSchema.parse({
      operation: "calibration",
      payload: { probabilities: [2], labels: [1] },
    }),
  ).toThrow();
  expect(
    researchRequest(
      researchInputSchema.parse({
        operation: "calibration",
        payload: { probabilities: [0.2], labels: [1] },
      }),
    ),
  ).toEqual({
    operation: "calibration",
    payload: { probabilities: [0.2], labels: [1], bins: 10 },
  });
});
it("requires optimizer development consent and independent reviewer", () => {
  expect(() =>
    researchInputSchema.parse({
      operation: "procedure_evaluate",
      payload: {
        seed: { researchInstructions: "test" },
        cases: [{ id: "one", split: "sealed", optimizerConsent: true }],
        reviewerId: "r",
        requestedBy: "r",
        optimizerConsent: true,
      },
    }),
  ).toThrow();
});
it("accepts provenance-bound observed traces and rejects foreign candidate scores", () => {
  const seed = { researchInstructions: "Read official evidence" };
  const input = {
    operation: "procedure_evaluate",
    payload: {
      seed,
      reviewerId: "reviewer",
      requestedBy: "owner",
      optimizerConsent: true,
      corpusVersion: "synthetic-v1",
      mode: "synthetic",
      maxCalls: 2,
      maxOutputTokens: 100,
      cases: [
        {
          id: "a",
          split: "development",
          optimizerConsent: true,
          candidateHash: optimizerCandidateHash(seed),
          expectedActions: ["read_report"],
          allowedEvidenceIds: ["report"],
          requiredEvidenceIds: ["report"],
          trace: {
            actions: ["read_report"],
            evidenceIds: ["report"],
            violations: [],
            output: "Checked report",
            error: null,
            modelCalls: 1,
            outputTokens: 20,
            latencyMs: 5,
            costUsd: 0,
          },
        },
      ],
    },
  };
  expect(researchInputSchema.parse(input)).toEqual(input);
  expect(() =>
    researchInputSchema.parse({
      ...input,
      payload: {
        ...input.payload,
        cases: [{ ...input.payload.cases[0], candidateHash: "a".repeat(64) }],
      },
    }),
  ).toThrow();
  expect(() =>
    researchInputSchema.parse({
      ...input,
      payload: {
        ...input.payload,
        cases: [{ ...input.payload.cases[0], grounding: 1 }],
      },
    }),
  ).toThrow();
});
it("bounds actual GEPA action replay to explicitly authorized development tools", () => {
  const payload = {
    seed: { proposedReadOrder: '["quote"]' },
    proposals: [{ proposedReadOrder: '["report"]' }],
    reviewerId: "reviewer",
    requestedBy: "owner",
    optimizerConsent: true,
    corpusVersion: "synthetic-v1",
    mode: "synthetic",
    maxCandidates: 2,
    cases: [
      {
        id: "a",
        split: "development",
        optimizerConsent: true,
        expectedActions: ["report"],
        allowedEvidenceIds: ["evidence"],
        requiredEvidenceIds: ["evidence"],
        tools: { quote: [], report: ["evidence"] },
      },
    ],
  };
  expect(
    researchInputSchema.parse({ operation: "procedure_optimize", payload })
      .payload,
  ).toEqual(payload);
  for (const patch of [
    { maxCandidates: 3 },
    { mode: "prospective" },
    { reviewerId: "owner" },
    {
      seed: {
        proposedReadOrder:
          "natural language cannot be executed by this evaluator",
      },
    },
  ]) {
    expect(() =>
      researchInputSchema.parse({
        operation: "procedure_optimize",
        payload: { ...payload, ...patch },
      }),
    ).toThrow();
  }
});
it("bounds scheduler settings and finishes idle passes", async () => {
  expect(() => researchSchedulerConfig({ RESEARCH_MAX_JOBS: "101" })).toThrow();
  let calls = 0;
  const result = await runResearchBatch({
    maxJobs: 3,
    deadlineMs: 1000,
    now: () => 0,
    runOne: async () => {
      calls++;
      return { checked: 0, completed: 0 };
    },
  });
  expect(calls).toBe(1);
  expect(result).toMatchObject({ checked: 0, completed: 0 });
});
it("stops at job budget and deadline", async () => {
  let time = 0;
  const result = await runResearchBatch({
    maxJobs: 10,
    deadlineMs: 50,
    now: () => time,
    runOne: async () => {
      time += 30;
      return { checked: 1, completed: 1 };
    },
  });
  expect(result.checked).toBe(2);
});
