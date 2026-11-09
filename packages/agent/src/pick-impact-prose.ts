import { z } from "zod";
import type { ReasonCondition } from "../../domain/src/pick-reason";
import { classifyPickImpact } from "../../domain/src/pick-impact";
import { validateImpactQuotes } from "./pick-impact-assessor";
import {
  assessDecisionEvidence,
  type ObservedDecisionQuote,
} from "./decision-evidence-assessment";
export const PROSE_IMPACT_RULES_VERSION = "pick-impact-prose-v1";
export const PROSE_IMPACT_PROMPT_VERSION = "pick-impact-prose-prompt-v1";
export const proseImpactOutputSchema = z
  .object({
    subjectId: z.string().min(1),
    eventId: z.string().min(1),
    evidenceRefs: z.array(z.string()).min(1).max(8),
    quotedSpans: z
      .array(
        z
          .object({ ref: z.string(), quote: z.string().min(1).max(1500) })
          .strict(),
      )
      .min(1)
      .max(8),
    evidenceState: z.enum(["supported", "contradicted", "unclear"]),
    conditionMet: z.boolean().nullable(),
    explanation: z.string().min(1).max(1600),
  })
  .strict();
export function evaluateProseImpact(
  input: {
    condition: ReasonCondition;
    eventId: string;
    observedAt: string;
    sourceAvailable: boolean;
    officialConfirmed: boolean;
    afterRef: string;
    snapshots: Record<string, string>;
    beforeQuote?: ObservedDecisionQuote | null;
    afterQuote?: ObservedDecisionQuote | null;
  },
  raw: unknown,
) {
  const inScope =
    input.condition.eventIds.includes(input.eventId) &&
    Number.isFinite(Date.parse(input.observedAt)) &&
    Date.parse(input.observedAt) >= Date.parse(input.condition.validFrom) &&
    Date.parse(input.observedAt) <= Date.parse(input.condition.validUntil);
  if (!inScope)
    return {
      state: "waiting_confirmation" as const,
      evidenceState: "unclear" as const,
      conditionMet: null,
      explanation:
        "This source change is outside the confirmed condition scope.",
      errorCode: "OUT_OF_SCOPE",
    };
  const parsed = proseImpactOutputSchema.safeParse(raw);
  const valid =
    parsed.success &&
    parsed.data.subjectId === input.condition.subjectId &&
    parsed.data.eventId === input.eventId &&
    validateImpactQuotes(input.snapshots, parsed.data) &&
    parsed.data.quotedSpans.some((q) => q.ref === input.afterRef);
  if (
    parsed.success &&
    ((parsed.data.evidenceState === "supported" &&
      parsed.data.conditionMet !== false) ||
      (parsed.data.evidenceState === "contradicted" &&
        parsed.data.conditionMet !== true) ||
      (parsed.data.evidenceState === "unclear" &&
        parsed.data.conditionMet !== null))
  )
    return {
      state: "waiting_confirmation" as const,
      evidenceState: "unclear" as const,
      conditionMet: null,
      explanation:
        "The source assessment was inconsistent and needs confirmation.",
      errorCode: "INVALID_MODEL_STATE",
    };
  const officialSatisfied =
    input.condition.sourcePolicy !== "official_required" ||
    input.officialConfirmed;
  if (!input.sourceAvailable)
    return {
      state: "check_unavailable" as const,
      evidenceState: "unclear" as const,
      conditionMet: null,
      explanation: "We couldn’t check this source. Your pick is unchanged.",
      errorCode: "SOURCE_UNAVAILABLE",
    };
  if (!valid)
    return {
      state: "waiting_confirmation" as const,
      evidenceState: "unclear" as const,
      conditionMet: null,
      explanation:
        "The report changed, but its supporting quotation could not be verified.",
      errorCode: "INVALID_MODEL_CITATION",
    };
  if (!officialSatisfied)
    return {
      state: "waiting_confirmation" as const,
      evidenceState: "unclear" as const,
      conditionMet: null,
      explanation: "Waiting for the official source to confirm your condition.",
      errorCode: "OFFICIAL_CONFIRMATION_REQUIRED",
    };
  const p = parsed.data;
  const contradiction =
    p.evidenceState === "contradicted" && p.conditionMet === true;
  const conditionMet = p.evidenceState === "unclear" ? null : p.conditionMet;
  return {
    decisionEvidence: assessDecisionEvidence({
      reasonImpact: contradiction
        ? "invalidated"
        : conditionMet === null
          ? "unknown"
          : "unchanged",
      beforeQuote: input.beforeQuote ?? null,
      afterQuote: input.afterQuote ?? null,
      observedAt: new Date(input.observedAt).toISOString(),
      challenger: null,
    }),
    state: classifyPickImpact({
      sourceAvailable: true,
      inScope: true,
      officialRequired: input.condition.sourcePolicy === "official_required",
      officialConfirmed: input.officialConfirmed,
      materialContradiction: conditionMet === null ? null : contradiction,
      conditionMet,
    }),
    evidenceState:
      conditionMet === null ? ("unclear" as const) : p.evidenceState,
    conditionMet,
    explanation: p.explanation,
    errorCode: null,
    evidenceRefs: p.evidenceRefs,
    quotedSpans: p.quotedSpans,
  };
}
