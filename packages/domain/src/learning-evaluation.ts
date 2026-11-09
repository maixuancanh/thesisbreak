import { z } from "zod";
import { retrievalCounts } from "./memory-benchmark";
export const learningActionAttemptSchema = z
  .object({
    pairId: z.string().min(1),
    fixtureId: z.string().min(1),
    arm: z.enum(["with_memory", "without_memory"]),
    modelVersion: z.string().min(1),
    promptVersion: z.string().min(1),
    questionHash: z.string().min(1),
    providerSnapshotHash: z.string().min(1),
    expectedMemoryIds: z.array(z.string()),
    retrievedMemoryIds: z.array(z.string()),
    usedMemoryIds: z.array(z.string()),
    expectedRequiredTools: z.array(z.string()),
    policyRequiredTools: z.array(z.string()),
    modelSelectedTools: z.array(z.string()),
    executedTools: z.array(z.string()),
    invalidProposal: z.boolean(),
    proposalBlocked: z.boolean(),
    plannerTrace: z.array(z.string()).min(1, "ACTION_TRACE_REQUIRED"),
    toolTrace: z.array(z.string()).min(1, "ACTION_TRACE_REQUIRED"),
    latencyMs: z.number().nonnegative(),
    costUsd: z.number().nonnegative().nullable(),
    failure: z.string().nullable(),
    correctionExpectedIds: z.array(z.string()).optional(),
    correctionActualIds: z.array(z.string()).optional(),
  })
  .strict();
export type LearningActionAttempt = z.infer<typeof learningActionAttemptSchema>;
export function evaluateLearningPairs(inputs: unknown[], k = 5) {
  if (!Number.isInteger(k) || k < 1) throw Error("INVALID_K");
  const attempts = inputs.map((x) => learningActionAttemptSchema.parse(x));
  const pairs = new Map<string, LearningActionAttempt[]>();
  for (const attempt of attempts)
    pairs.set(attempt.pairId, [...(pairs.get(attempt.pairId) ?? []), attempt]);
  let completePairs = 0,
    failedPairs = 0;
  for (const pair of pairs.values()) {
    if (pair.length > 2 || new Set(pair.map((a) => a.arm)).size !== pair.length)
      throw Error("DUPLICATE_ARM");
    const first = pair[0];
    if (!first) throw Error("EMPTY_PAIR");
    if (
      pair.some((a) =>
        [
          "fixtureId",
          "modelVersion",
          "promptVersion",
          "questionHash",
          "providerSnapshotHash",
        ].some(
          (k) =>
            a[k as keyof LearningActionAttempt] !==
            first[k as keyof LearningActionAttempt],
        ),
      )
    )
      throw Error("UNMATCHED_PAIR");
    if (pair.length === 2 && pair.every((a) => a.failure === null))
      completePairs++;
    else failedPairs++;
  }
  const relevant = attempts.reduce(
    (n, a) => n + new Set(a.expectedMemoryIds).size,
    0,
  );
  const hits = attempts.reduce(
    (n, a) =>
      n +
      retrievalCounts(a.expectedMemoryIds, a.retrievedMemoryIds, k).hits,
    0,
  );
  const required = attempts.reduce(
    (n, a) => n + new Set(a.expectedRequiredTools).size,
    0,
  );
  const completed = attempts.reduce(
    (n, a) =>
      n +
      [...new Set(a.expectedRequiredTools)].filter((t) =>
        a.executedTools.includes(t),
      ).length,
    0,
  );
  return {
    attempts,
    attemptCount: attempts.length,
    pairCount: pairs.size,
    completePairs,
    failedPairs,
    failedAttempts: attempts.filter((a) => a.failure !== null).length,
    recallAtK: relevant ? hits / relevant : null,
    recallDenominator: relevant,
    wrongMemoryUses: attempts.reduce(
      (n, a) =>
        n +
        a.usedMemoryIds.filter((id) => !a.expectedMemoryIds.includes(id))
          .length,
      0,
    ),
    requiredToolCompletion: required ? completed / required : null,
    requiredToolDenominator: required,
    invalidProposalsBlocked: attempts.filter(
      (a) => a.invalidProposal && a.proposalBlocked,
    ).length,
    invalidProposalDenominator: attempts.filter((a) => a.invalidProposal)
      .length,
    correctionWrongTargets: attempts.reduce(
      (n, a) =>
        n +
        (a.correctionActualIds ?? []).filter(
          (id) => !(a.correctionExpectedIds ?? []).includes(id),
        ).length,
      0,
    ),
    totalLatencyMs: attempts.reduce((n, a) => n + a.latencyMs, 0),
    totalCostUsd: attempts.some((a) => a.costUsd === null)
      ? null
      : attempts.reduce((n, a) => n + (a.costUsd ?? 0), 0),
    costMeasurementCoverage: attempts.length
      ? attempts.filter((a) => a.costUsd !== null).length / attempts.length
      : null,
    confirmedGroundingImprovement: false as const,
    note: "Controlled action traces; independent human rubric review and prospective accuracy evaluation remain required.",
  };
}
