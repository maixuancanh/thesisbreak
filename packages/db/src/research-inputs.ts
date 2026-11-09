import { z } from "zod";
import { createHash } from "node:crypto";
const probability = z.number().finite().min(0).max(1);
const timestamp = z.iso.datetime({ offset: true });
const observation = z
  .object({
    forecastId: z.string().min(1),
    eventId: z.string().min(1),
    outcomeVersion: z.number().int().positive(),
    challengerVersion: z.string().min(1),
    availableAt: timestamp,
    cutoffAt: timestamp,
    probability,
    label: z.union([z.literal(0), z.literal(1)]),
    league: z.string().min(1),
    marketType: z.string().min(1),
    horizon: z.string().min(1),
    primary: z.boolean(),
  })
  .strict()
  .refine(
    (r) => Date.parse(r.availableAt) > Date.parse(r.cutoffAt),
    "LABEL_BEFORE_FORECAST",
  );
const calibration = z
  .object({
    operation: z.literal("calibration"),
    payload: z
      .object({
        probabilities: z.array(probability).max(10000),
        labels: z.array(z.union([z.literal(0), z.literal(1)])).max(10000),
        bins: z.number().int().min(1).max(100).default(10),
      })
      .strict()
      .refine(
        (p) => p.probabilities.length === p.labels.length,
        "COHORT_LENGTH_MISMATCH",
      ),
  })
  .strict();
const calibrationExperiment = z
  .object({
    operation: z.literal("calibration_experiment"),
    payload: z
      .object({
        train: z.array(observation).min(1).max(10000),
        validation: z.array(observation).min(1).max(10000),
        heldout: z.array(observation).min(1).max(10000),
        fitAt: timestamp,
        selectionAt: timestamp,
        asOf: timestamp,
        methods: z
          .array(z.enum(["logistic", "beta", "isotonic"]))
          .min(1)
          .max(3),
      })
      .strict(),
  })
  .strict();
const online = z
  .object({
    operation: z.literal("online_learning"),
    payload: z
      .object({ rows: z.array(observation).max(10000), asOf: timestamp })
      .strict(),
  })
  .strict();
export const optimizerCandidateSchema = z
  .object({
    researchInstructions: z.string().trim().min(1).max(16000).optional(),
    queryTemplates: z.string().trim().min(1).max(16000).optional(),
    proposedReadOrder: z.string().trim().min(1).max(16000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export function optimizerCandidateHash(
  candidate: z.infer<typeof optimizerCandidateSchema>,
) {
  const parsed = optimizerCandidateSchema.parse(candidate);
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(parsed).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        ),
      ),
    )
    .digest("hex");
}
const ids = z.array(z.string().trim().min(1).max(300)).max(100);
const requiredIds = ids.min(1);
const procedure = z
  .object({
    operation: z.literal("procedure_evaluate"),
    payload: z
      .object({
        seed: optimizerCandidateSchema,
        cases: z
          .array(
            z
              .object({
                id: z.string().min(1),
                split: z.literal("development"),
                optimizerConsent: z.literal(true),
                candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
                expectedActions: requiredIds,
                allowedEvidenceIds: requiredIds,
                requiredEvidenceIds: requiredIds,
                trace: z
                  .object({
                    actions: ids,
                    evidenceIds: ids,
                    violations: ids,
                    output: z.string().max(16000),
                    error: z.string().max(1000).nullable(),
                    modelCalls: z.number().int().min(0).max(2),
                    outputTokens: z.number().int().nonnegative(),
                    latencyMs: z.number().finite().nonnegative(),
                    costUsd: z.number().finite().nonnegative(),
                  })
                  .strict(),
              })
              .strict(),
          )
          .min(1)
          .max(10),
        reviewerId: z.string().min(1),
        requestedBy: z.string().min(1),
        optimizerConsent: z.literal(true),
        corpusVersion: z.string().trim().min(1).max(300),
        mode: z.enum(["synthetic", "historical_replay", "prospective"]),
        maxCalls: z.number().int().min(0).max(60),
        maxOutputTokens: z.number().int().min(0).max(1000000),
      })
      .strict()
      .refine(
        (p) => p.reviewerId !== p.requestedBy,
        "INDEPENDENT_REVIEWER_REQUIRED",
      )
      .refine(
        (p) => new Set(p.cases.map((c) => c.id)).size === p.cases.length,
        "DUPLICATE_CASE",
      )
      .refine(
        (p) =>
          p.cases.every(
            (c) => c.candidateHash === optimizerCandidateHash(p.seed),
          ),
        "CANDIDATE_TRACE_MISMATCH",
      )
      .refine(
        (p) =>
          p.cases.every((c) =>
            c.requiredEvidenceIds.every((id) =>
              c.allowedEvidenceIds.includes(id),
            ),
          ),
        "INVALID_GOLD_EVIDENCE",
      ),
  })
  .strict();
const readOrderCandidate = z
  .object({ proposedReadOrder: z.string().min(1).max(16000) })
  .strict()
  .refine((c) => {
    try {
      const actions: unknown = JSON.parse(c.proposedReadOrder);
      return (
        Array.isArray(actions) &&
        actions.length <= 100 &&
        actions.every((a) => typeof a === "string" && a.length > 0)
      );
    } catch {
      return false;
    }
  }, "INVALID_READ_ORDER");
const procedureOptimize = z
  .object({
    operation: z.literal("procedure_optimize"),
    payload: z
      .object({
        seed: readOrderCandidate,
        proposals: z.array(readOrderCandidate).max(2),
        reviewerId: z.string().trim().min(1).max(300),
        requestedBy: z.string().trim().min(1).max(300),
        optimizerConsent: z.literal(true),
        corpusVersion: z.string().trim().min(1).max(300),
        mode: z.enum(["synthetic", "historical_replay"]),
        maxCandidates: z.number().int().min(1).max(3),
        cases: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).max(300),
                split: z.literal("development"),
                optimizerConsent: z.literal(true),
                expectedActions: requiredIds,
                allowedEvidenceIds: requiredIds,
                requiredEvidenceIds: requiredIds,
                tools: z.record(z.string().trim().min(1).max(300), ids),
              })
              .strict(),
          )
          .min(1)
          .max(10),
      })
      .strict()
      .refine(
        (p) => p.reviewerId !== p.requestedBy,
        "INDEPENDENT_REVIEWER_REQUIRED",
      )
      .refine(
        (p) => p.maxCandidates === p.proposals.length + 1,
        "CANDIDATE_CAP_MISMATCH",
      )
      .refine(
        (p) => new Set(p.cases.map((c) => c.id)).size === p.cases.length,
        "DUPLICATE_CASE",
      )
      .refine(
        (p) =>
          p.cases.every((c) =>
            [...c.requiredEvidenceIds, ...Object.values(c.tools).flat()].every(
              (id) => c.allowedEvidenceIds.includes(id),
            ),
          ),
        "INVALID_GOLD_EVIDENCE",
      ),
  })
  .strict();
export const researchInputSchema = z.discriminatedUnion("operation", [
  calibration,
  calibrationExperiment,
  online,
  procedure,
  procedureOptimize,
]);
export type ResearchInput = z.infer<typeof researchInputSchema>;
export function researchRequest(input: ResearchInput) {
  return researchInputSchema.parse(input);
}
