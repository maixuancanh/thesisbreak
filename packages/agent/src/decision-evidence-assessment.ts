import { z } from "zod";
import {
  decisionEvidenceAssessmentSchema,
  observedDecisionQuoteSchema,
} from "../../domain/src/decision-evidence-assessment";
export { observedDecisionQuoteSchema } from "../../domain/src/decision-evidence-assessment";
import {
  shadowPromotion,
  type evaluateChronological,
} from "../../domain/src/forecast-model";

const id = z.string().trim().min(1).max(300);
const time = z.iso.datetime({ offset: true });
export type ObservedDecisionQuote = z.infer<typeof observedDecisionQuoteSchema>;
export const decisionEvidenceConfigSchema = z
  .object({
    version: id,
    freshnessSeconds: z.number().int().positive().max(86400),
    horizonSeconds: z.number().int().positive().max(604800),
    movementThreshold: z.number().finite().min(0).max(1),
  })
  .strict();
export const DEFAULT_DECISION_EVIDENCE_CONFIG = Object.freeze({
  version: "decision-evidence-v1",
  freshnessSeconds: 900,
  horizonSeconds: 3600,
  movementThreshold: 0.005,
});
// Only a server adapter of the existing chronological calibration pipeline may supply
// this result. This assessment neither fits a model nor grants experiment consent.
const challengerSchema = z
  .object({
    version: id,
    cutoff: time,
    baselineAt: time,
    consented: z.boolean(),
    currentEligible: z.boolean(),
    baselineProbability: z.number().min(0).max(1),
    probability: z.number().finite().min(0).max(1),
    evaluation: z
      .object({
        heldoutAfterTraining: z.boolean(),
        pairedEvents: z.number().int().nonnegative(),
        pairedCoverage: z.number().min(0).max(1),
        improvementInterval: z
          .object({ lower: z.number().finite(), upper: z.number().finite() })
          .passthrough()
          .nullable(),
        pairedModelLogLoss: z.number().finite().nonnegative().nullable(),
        pairedBaselineLogLoss: z.number().finite().nonnegative().nullable(),
      })
      .passthrough(),
  })
  .strict();
const inputSchema = z
  .object({
    reasonImpact: z.enum(["unchanged", "weakened", "invalidated", "unknown"]),
    beforeQuote: observedDecisionQuoteSchema.nullable(),
    afterQuote: observedDecisionQuoteSchema.nullable(),
    observedAt: time.optional(),
    triggerObservedAt: time.optional(),
    challenger: challengerSchema.nullish(),
    config: decisionEvidenceConfigSchema.optional(),
  })
  .strict();

/** Recorded observations only. A reason alert survives every missing-price/model gate. */
export function assessDecisionEvidence(value: unknown) {
  const input = inputSchema.parse(value);
  const config = input.config ?? DEFAULT_DECISION_EVIDENCE_CONFIG;
  // Legacy minimal calls have no clock: retain a deterministic sentinel and abstain
  // from freshness-dependent assessment. Runtime adapters always supply observedAt.
  const checkedAt = input.observedAt ?? "1970-01-01T00:00:00.000Z";
  const now = Date.parse(checkedAt);
  const before = input.beforeQuote,
    after = input.afterQuote;
  const beforeAt = before ? Date.parse(before.observedAt) : NaN;
  const afterAt = after ? Date.parse(after.observedAt) : NaN;
  const comparable =
    !!before &&
    !!after &&
    (
      ["provider", "marketId", "outcomeId", "rulesHash", "quoteType"] as const
    ).every((k) => before[k] === after[k]) &&
    [before, after].every((q) => q.status === "open" && q.liquidityAvailable) &&
    beforeAt <= afterAt &&
    afterAt <= now &&
    now - afterAt <= config.freshnessSeconds * 1000 &&
    now - beforeAt <= config.horizonSeconds * 1000 &&
    (!input.triggerObservedAt ||
      (beforeAt <= Date.parse(input.triggerObservedAt) &&
        afterAt >= Date.parse(input.triggerObservedAt)));
  let adjustmentStatus:
    "insufficient_evidence" | "candidate_only" | "validated_challenger" =
    "insufficient_evidence";
  const challenger = input.challenger;
  if (
    challenger &&
    challenger.consented &&
    challenger.currentEligible &&
    Date.parse(challenger.cutoff) <= now &&
    challenger.baselineAt === checkedAt
  ) {
    adjustmentStatus =
      shadowPromotion(
        challenger.evaluation as ReturnType<typeof evaluateChronological>,
      ).status === "review_candidate"
        ? "validated_challenger"
        : "candidate_only";
  }
  return decisionEvidenceAssessmentSchema.parse({
    reasonImpact: input.reasonImpact,
    needsReview:
      input.reasonImpact === "weakened" || input.reasonImpact === "invalidated",
    priceAssessment: !comparable
      ? "unknown"
      : Math.abs(after!.probability - before!.probability) >
          config.movementThreshold
        ? "movement_observed"
        : "no_observed_movement",
    adjustmentStatus,
    // Validated research is still a challenger: changing a forecast uses its separate
    // reviewed pipeline. No probability is inferred from a source change or quotes.
    adjustedProbability: null,
    evidenceIds: [
      ...new Set([before?.id, after?.id].filter((id): id is string => !!id)),
    ],
    configVersion: config.version,
    checkedAt,
    quoteContext: { before: before ?? null, after: after ?? null },
  });
}

/** No synthetic pre-event quote or backfill: choose only snapshots already recorded. */
export function selectDecisionQuoteSnapshots(input: {
  quotes: ObservedDecisionQuote[];
  triggerObservedAt: string;
  now: string;
  config?: z.infer<typeof decisionEvidenceConfigSchema>;
}) {
  const trigger = Date.parse(time.parse(input.triggerObservedAt));
  const now = Date.parse(time.parse(input.now));
  const config = decisionEvidenceConfigSchema.parse(
    input.config ?? DEFAULT_DECISION_EVIDENCE_CONFIG,
  );
  const quotes = input.quotes
    .map((q) => observedDecisionQuoteSchema.parse(q))
    .filter((q) => Date.parse(q.observedAt) <= now)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return {
    beforeQuote:
      quotes
        .filter(
          (q) =>
            Date.parse(q.observedAt) <= trigger &&
            trigger - Date.parse(q.observedAt) <= config.horizonSeconds * 1000,
        )
        .at(-1) ?? null,
    afterQuote:
      quotes
        .filter(
          (q) =>
            Date.parse(q.observedAt) >= trigger &&
            now - Date.parse(q.observedAt) <= config.freshnessSeconds * 1000,
        )
        .at(-1) ?? null,
  };
}
