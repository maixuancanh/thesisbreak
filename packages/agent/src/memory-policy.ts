import { z } from "zod";
import {
  assessMemoryValidity,
  assessSourceSpecialization,
  researchScopeSchema,
  assessActionUsefulness,
} from "../../domain/src/research-policy";
import { validateSourceScore } from "../../domain/src/source-credibility";

export const memoryPolicySchema = z
  .object({
    version: z.literal("forecast-validity-v1"),
    scope: researchScopeSchema,
    regime: z.string().min(1).max(256),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const researchAuditSchema = z.object({
  memoryDecisions: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum([
          "historical_context_only",
          "eligible_history",
          "excluded",
        ]),
        reasons: z.array(z.string()),
      }),
    )
    .max(8),
  sourceAssessments: z
    .array(
      z.object({
        id: z.string(),
        applicable: z.boolean(),
        factSamples: z.number().int(),
        factRate: z.number().min(0).max(1).nullable().optional(),
        factVerification: z
          .literal("account_owner_review_not_independently_verified")
          .optional(),
        forecastSamples: z.number().int(),
        brier: z.number().nullable(),
        reason: z.string(),
      }),
    )
    .max(4),
  action: z.enum(["waited", "abstained", "unchanged"]),
  evidenceRefs: z.array(z.string()).max(20),
  evidenceLevel: z.literal("unmeasured"),
  improvementSupported: z.literal(false),
  proposalWithheld: z.boolean(),
});

/** History without explicit scope/validity stays historical; never invent a specialization or expiry. */
export function applyResearchMemoryPolicy(input: {
  userId: string;
  now: Date;
  requestedScope?: z.infer<typeof researchScopeSchema>;
  currentRegime?: string;
  forecastMemories: unknown[];
  sourceMemories: unknown[];
}) {
  const decisions: z.infer<typeof researchAuditSchema>["memoryDecisions"] = [];
  const forecasts: unknown[] = [];
  for (const raw of input.forecastMemories.slice(0, 4)) {
    const parsed = z
      .object({
        userId: z.string(),
        forecastId: z.string(),
        forecast: z.object({
          scheduledAt: z.iso.datetime({ offset: true }),
          modelConfig: z.record(z.string(), z.unknown()),
        }),
        capturedAt: z.iso.datetime({ offset: true }).optional(),
      })
      .safeParse(raw);
    if (!parsed.success || parsed.data.userId !== input.userId) continue;
    const m = parsed.data,
      policy = memoryPolicySchema.safeParse(
        m.forecast.modelConfig.memoryPolicy,
      );
    if (m.capturedAt && Date.parse(m.capturedAt) > input.now.getTime()) {
      decisions.push({
        id: m.forecastId,
        role: "excluded",
        reasons: ["future_record"],
      });
      continue;
    }
    if (
      !policy.success ||
      !m.capturedAt ||
      !input.requestedScope ||
      !input.currentRegime
    ) {
      decisions.push({
        id: m.forecastId,
        role: "historical_context_only",
        reasons: ["explicit_validity_or_requested_scope_missing"],
      });
      forecasts.push(raw);
      continue;
    }
    try {
      const validity = assessMemoryValidity({
        now: input.now.toISOString(),
        recordedAt: m.capturedAt,
        expiresAt: policy.data.expiresAt,
        regime: policy.data.regime,
        currentRegime: input.currentRegime,
        scope: policy.data.scope,
        requestedScope: input.requestedScope,
        active: true,
        evidenceRefs: [m.forecastId],
      });
      decisions.push({
        id: m.forecastId,
        role: validity.applicable ? "eligible_history" : "excluded",
        reasons: validity.reasons,
      });
      if (validity.applicable) forecasts.push(raw);
    } catch {
      decisions.push({
        id: m.forecastId,
        role: "excluded",
        reasons: ["invalid_validity_metadata"],
      });
    }
  }
  const sourceAssessments: z.infer<
    typeof researchAuditSchema
  >["sourceAssessments"] = [];
  const sourceMemories: unknown[] = [];
  for (const raw of input.sourceMemories.slice(0, 4)) {
    try {
      const s = validateSourceScore(raw);
      if (s.userId !== input.userId) continue;
      if (Date.parse(s.updatedAt) > input.now.getTime()) continue;
      sourceMemories.push(s);
      // Existing source records certify category/competition only. Exact market/horizon is unknown.
      const scope = input.requestedScope ?? {
        league: s.cohort,
        market: "unspecified",
        horizon: "unspecified",
      };
      const probabilistic = s.forecasts.filter(
        (f) =>
          f.status === "final" &&
          f.winner !== null &&
          f.probability !== null &&
          f.scheduledAt &&
          f.resolvedAt &&
          Date.parse(f.resolvedAt) <= input.now.getTime() &&
          !!f.scope &&
          f.scope.league === scope.league &&
          f.scope.market === scope.market &&
          f.scope.horizon === scope.horizon &&
          Date.parse(f.recordedAt) < Date.parse(f.scheduledAt) &&
          Date.parse(f.resolvedAt) > Date.parse(f.scheduledAt),
      );
      const facts = (s.factReviews ?? []).filter(
        (r) =>
          r.verdict !== "unclear" &&
          Date.parse(r.reviewedAt) <= input.now.getTime() &&
          r.scope.league === scope.league &&
          r.scope.market === scope.market &&
          r.scope.horizon === scope.horizon,
      );
      const brier = probabilistic.length
        ? probabilistic.reduce(
            (n, f) =>
              n + (f.probability! - Number(f.outcome === f.winner)) ** 2,
            0,
          ) / probabilistic.length
        : null;
      const assessed = assessSourceSpecialization({
        scope,
        requestedScope: input.requestedScope ?? {
          league: "unknown",
          market: "unknown",
          horizon: "unknown",
        },
        factChecks: {
          correct: facts.filter((f) => f.verdict === "supported").length,
          total: facts.length,
          evidenceRefs: facts.map((f) => f.evidenceReference),
        },
        forecasts: {
          resolved: probabilistic.length,
          brierScore: brier,
          evidenceRefs: probabilistic.map((f) => f.reference),
        },
      });
      sourceAssessments.push({
        id: s.id,
        applicable:
          assessed.applicable && (probabilistic.length > 0 || facts.length > 0),
        factSamples: facts.length,
        factRate: assessed.factCorrectness.rate,
        factVerification: "account_owner_review_not_independently_verified",
        forecastSamples: probabilistic.length,
        brier: assessed.forecastQuality.brierScore,
        reason:
          probabilistic.length || facts.length
            ? "exact_scope_samples_keep_user_reviews_separate_from_forecasts"
            : "no_exact_scope_samples",
      });
    } catch {
      /* Malformed or foreign history cannot influence the planner. */
    }
  }
  return {
    forecastMemories: forecasts,
    memoryDecisions: decisions,
    sourceAssessments,
    sourceMemories,
  };
}
export function researchActionAudit(
  input: {
    action: "waited" | "abstained" | "unchanged";
    evidenceRefs: string[];
    proposalWithheld: boolean;
  },
  policy: ReturnType<typeof applyResearchMemoryPolicy>,
) {
  const usefulness = assessActionUsefulness({
    action: input.action,
    evidenceRefs: input.evidenceRefs,
    outcomeObserved: false,
    evaluation: "none",
    evaluationRefs: [],
    measuredImprovement: null,
  });
  return researchAuditSchema.parse({
    memoryDecisions: policy.memoryDecisions,
    sourceAssessments: policy.sourceAssessments,
    action: input.action,
    evidenceRefs: input.evidenceRefs,
    evidenceLevel: usefulness.evidenceLevel,
    improvementSupported: false,
    proposalWithheld: input.proposalWithheld,
  });
}
