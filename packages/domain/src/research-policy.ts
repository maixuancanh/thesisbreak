import { z } from "zod";

const id = z.string().trim().min(1).max(256);
const time = z.iso.datetime({ offset: true });
export const researchScopeSchema = z
  .object({ league: id, market: id, horizon: id })
  .strict();
const refs = z.array(id).max(100);
const scopeMatches = (
  a: z.infer<typeof researchScopeSchema>,
  b: z.infer<typeof researchScopeSchema>,
) => a.league === b.league && a.market === b.market && a.horizon === b.horizon;

const specializationSchema = z
  .object({
    scope: researchScopeSchema,
    requestedScope: researchScopeSchema,
    factChecks: z
      .object({
        correct: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        evidenceRefs: refs,
      })
      .strict(),
    forecasts: z
      .object({
        resolved: z.number().int().nonnegative(),
        brierScore: z.number().min(0).max(1).nullable(),
        evidenceRefs: refs,
      })
      .strict(),
  })
  .strict()
  .refine(
    (x) => x.factChecks.correct <= x.factChecks.total,
    "INVALID_FACT_COUNTS",
  )
  .refine(
    (x) => x.factChecks.total === 0 || x.factChecks.evidenceRefs.length > 0,
    "FACT_EVIDENCE_REQUIRED",
  )
  .refine(
    (x) =>
      x.forecasts.resolved === 0
        ? x.forecasts.brierScore === null
        : x.forecasts.brierScore !== null &&
          x.forecasts.evidenceRefs.length > 0,
    "FORECAST_EVIDENCE_REQUIRED",
  );

/** Factual accuracy never substitutes for measured forecast quality. */
export function assessSourceSpecialization(
  input: z.input<typeof specializationSchema>,
) {
  const x = specializationSchema.parse(input);
  const applicable = scopeMatches(x.scope, x.requestedScope);
  return {
    applicable,
    scope: x.scope,
    factCorrectness: {
      rate:
        applicable && x.factChecks.total
          ? x.factChecks.correct / x.factChecks.total
          : null,
      samples: x.factChecks.total,
      evidenceRefs: x.factChecks.evidenceRefs,
    },
    forecastQuality: {
      brierScore: applicable ? x.forecasts.brierScore : null,
      samples: x.forecasts.resolved,
      evidenceRefs: x.forecasts.evidenceRefs,
    },
    reason: applicable ? "exact_scope" : "scope_mismatch",
  };
}

export const originSourceSchema = z
  .object({
    id,
    url: z.url(),
    canonicalOriginId: id.nullable(),
    provenanceRefs: refs,
  })
  .strict()
  .refine(
    (x) => x.canonicalOriginId === null || x.provenanceRefs.length > 0,
    "ORIGIN_PROVENANCE_REQUIRED",
  );

/** URLs and publishers alone cannot establish independent reporting. */
export function groupCanonicalOrigins(
  input: z.input<typeof originSourceSchema>[],
) {
  const sources = z.array(originSourceSchema).max(100).parse(input);
  if (new Set(sources.map((s) => s.id)).size !== sources.length)
    throw new Error("DUPLICATE_SOURCE_ID");
  const groups = new Map<string, string[]>();
  for (const s of sources)
    if (s.canonicalOriginId !== null) {
      const ids = groups.get(s.canonicalOriginId) ?? [];
      ids.push(s.id);
      groups.set(s.canonicalOriginId, ids);
    }
  return {
    groups: [...groups].map(([canonicalOriginId, sourceIds]) => ({
      canonicalOriginId,
      sourceIds,
    })),
    unknownSourceIds: sources
      .filter((s) => s.canonicalOriginId === null)
      .map((s) => s.id),
    independence: "not_established" as const,
  };
}

const validitySchema = z
  .object({
    now: time,
    recordedAt: time,
    expiresAt: time,
    regime: id,
    currentRegime: id,
    scope: researchScopeSchema,
    requestedScope: researchScopeSchema,
    active: z.boolean(),
    evidenceRefs: refs,
  })
  .strict()
  .refine(
    (x) => Date.parse(x.expiresAt) > Date.parse(x.recordedAt),
    "INVALID_VALIDITY_WINDOW",
  );
export function assessMemoryValidity(input: z.input<typeof validitySchema>) {
  const x = validitySchema.parse(input);
  const reasons: string[] = [];
  if (!x.active) reasons.push("inactive");
  if (Date.parse(x.recordedAt) > Date.parse(x.now))
    reasons.push("future_record");
  if (Date.parse(x.expiresAt) <= Date.parse(x.now)) reasons.push("expired");
  if (x.regime !== x.currentRegime) reasons.push("regime_changed");
  if (!scopeMatches(x.scope, x.requestedScope)) reasons.push("scope_mismatch");
  if (!x.evidenceRefs.length) reasons.push("missing_evidence");
  return { applicable: reasons.length === 0, reasons };
}

const readinessSchema = z
  .object({
    requiresLineup: z.boolean(),
    lineupConfirmed: z.boolean(),
    staleEvidence: z.boolean(),
    conflictingEvidence: z.boolean(),
    evidenceRefs: refs,
  })
  .strict();
export function assessResearchReadiness(
  input: z.input<typeof readinessSchema>,
) {
  const x = readinessSchema.parse(input);
  const reasons: string[] = [];
  if (x.staleEvidence) reasons.push("stale_evidence");
  if (x.conflictingEvidence) reasons.push("conflicting_evidence");
  if (!x.evidenceRefs.length) reasons.push("missing_evidence");
  if (x.requiresLineup && !x.lineupConfirmed) reasons.push("lineup_pending");
  return {
    action: reasons.some((r) => r !== "lineup_pending")
      ? ("abstain" as const)
      : reasons.length
        ? ("wait" as const)
        : ("ready" as const),
    reasons,
  };
}

const usefulnessSchema = z
  .object({
    action: z.enum(["changed_pick", "waited", "abstained", "unchanged"]),
    evidenceRefs: refs,
    outcomeObserved: z.boolean(),
    evaluation: z.enum(["none", "observational", "controlled"]),
    evaluationRefs: refs,
    measuredImprovement: z.number().finite().nullable(),
  })
  .strict()
  .refine(
    (x) =>
      x.evaluation === "none"
        ? x.measuredImprovement === null
        : x.evaluationRefs.length > 0,
    "EVALUATION_EVIDENCE_REQUIRED",
  );
export function assessActionUsefulness(
  input: z.input<typeof usefulnessSchema>,
) {
  const x = usefulnessSchema.parse(input);
  const causal =
    x.evaluation === "controlled" &&
    x.evidenceRefs.length > 0 &&
    x.measuredImprovement !== null;
  return {
    action: x.action,
    evidenceRefs: x.evidenceRefs,
    evidenceLevel: causal
      ? "controlled"
      : x.evaluation === "observational"
        ? "observational"
        : "unmeasured",
    improvementSupported: causal && x.measuredImprovement! > 0,
    measuredImprovement: x.evaluation === "none" ? null : x.measuredImprovement,
    outcomeObserved: x.outcomeObserved,
    note: causal
      ? "Controlled evaluation supports only its measured scope."
      : "Observed outcomes or changed actions do not establish improvement.",
  };
}

const reasonSchema = z
  .object({ text: z.string().trim().min(1).max(12000), evidenceRefs: refs })
  .strict();
const comparisonSchema = z
  .object({
    before: reasonSchema,
    after: reasonSchema,
    availableEvidenceRefs: refs,
  })
  .strict();
export function compareReasonEvidence(input: z.input<typeof comparisonSchema>) {
  const x = comparisonSchema.parse(input);
  const available = new Set(x.availableEvidenceRefs);
  const unknownEvidenceRefs = [
    ...new Set(
      [...x.before.evidenceRefs, ...x.after.evidenceRefs].filter(
        (r) => !available.has(r),
      ),
    ),
  ];
  return {
    changed: x.before.text !== x.after.text,
    grounded:
      x.before.evidenceRefs.length > 0 &&
      x.after.evidenceRefs.length > 0 &&
      !unknownEvidenceRefs.length,
    unknownEvidenceRefs,
    addedEvidenceRefs: [
      ...new Set(
        x.after.evidenceRefs.filter((r) => !x.before.evidenceRefs.includes(r)),
      ),
    ],
    removedEvidenceRefs: [
      ...new Set(
        x.before.evidenceRefs.filter((r) => !x.after.evidenceRefs.includes(r)),
      ),
    ],
    improvementEstablished: false as const,
    note: "Evidence references establish traceability; they do not verify semantic support or prove reasoning improved.",
  };
}
