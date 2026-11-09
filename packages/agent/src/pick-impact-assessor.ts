import type { ReasonCondition } from "../../domain/src/pick-reason";
import { classifyPickImpact } from "../../domain/src/pick-impact";
import {
  assessDecisionEvidence,
  type ObservedDecisionQuote,
} from "./decision-evidence-assessment";
export const PICK_IMPACT_RULES_VERSION = "pick-impact-v1";
export function assessPickCondition(v: {
  condition: ReasonCondition;
  eventId: string;
  observedAt: string;
  sourceAvailable: boolean;
  before: string;
  after: string;
  referenceId: string;
  beforeQuote?: ObservedDecisionQuote | null;
  afterQuote?: ObservedDecisionQuote | null;
  structured?: {
    subjectId: string;
    eventId: string;
    official: boolean;
    lineupStatus?: "starter" | "available" | "not_starter" | "unavailable";
    revision?: "corrected" | "withdrawn" | "original";
    final?: boolean;
  };
}) {
  const c = v.condition;
  const inScope =
    c.eventIds.includes(v.eventId) &&
    Date.parse(v.observedAt) >= Date.parse(c.validFrom) &&
    Date.parse(v.observedAt) <= Date.parse(c.validUntil);
  let conditionMet: boolean | null = null;
  let contradiction: boolean | null = null;
  const s = v.structured;
  const valid = !!s && s.subjectId === c.subjectId && s.eventId === v.eventId;
  let explanation =
    "The report changed. The stated condition needs confirmation.";
  if (
    valid &&
    inScope &&
    v.sourceAvailable &&
    (c.sourcePolicy !== "official_required" || s.official)
  ) {
    if (c.predicate.type === "lineup_status" && s.lineupStatus) {
      conditionMet =
        c.predicate.revisitOn === "not_starter"
          ? s.lineupStatus === "not_starter" || s.lineupStatus === "unavailable"
            ? true
            : s.lineupStatus === "starter"
              ? false
              : null
          : s.lineupStatus === "unavailable"
            ? true
            : s.lineupStatus === "available" || s.lineupStatus === "starter"
              ? false
              : null;
      contradiction = conditionMet;
      explanation = conditionMet
        ? "The official lineup meets your revisit condition."
        : "The lineup does not meet your revisit condition.";
    }
    if (
      c.predicate.type === "source_revision" &&
      c.predicate.referenceId === v.referenceId &&
      s.revision
    ) {
      conditionMet = s.revision === c.predicate.revisitOn;
      contradiction = conditionMet;
    }
    if (c.predicate.type === "event_final" && s.final !== undefined) {
      conditionMet = s.final;
      contradiction = false;
      explanation =
        "The official result is ready for a recap. It does not establish whether your reason was right.";
    }
  }
  const state = classifyPickImpact({
    sourceAvailable: v.sourceAvailable,
    inScope,
    officialRequired: c.sourcePolicy === "official_required",
    officialConfirmed: valid && s.official === true,
    materialContradiction: contradiction,
    conditionMet,
  });
  return {
    decisionEvidence: assessDecisionEvidence({
      reasonImpact:
        contradiction === true
          ? "invalidated"
          : contradiction === false
            ? "unchanged"
            : "unknown",
      beforeQuote: v.beforeQuote ?? null,
      afterQuote: v.afterQuote ?? null,
      observedAt: Number.isFinite(Date.parse(v.observedAt))
        ? new Date(v.observedAt).toISOString()
        : "1970-01-01T00:00:00.000Z",
      challenger: null,
    }),
    inScope,
    state:
      c.predicate.type === "event_final" && conditionMet !== null
        ? "still_watching"
        : state,
    evidenceState:
      contradiction === true
        ? ("contradicted" as const)
        : contradiction === false
          ? ("supported" as const)
          : ("unclear" as const),
    conditionMet,
    explanation: !v.sourceAvailable
      ? "We couldn’t check this source. Your pick is unchanged."
      : explanation,
    rulesVersion: PICK_IMPACT_RULES_VERSION,
    modelVersion: null,
  };
}
/** Any prose assessment must cite exact snapshot spans; failed checks cannot publish a contradiction. */
export function validateImpactQuotes(
  snapshots: Record<string, string>,
  proposed: {
    evidenceRefs: string[];
    quotedSpans: { ref: string; quote: string }[];
  },
) {
  return (
    proposed.evidenceRefs.length > 0 &&
    proposed.quotedSpans.length > 0 &&
    proposed.evidenceRefs.every((ref) => Object.hasOwn(snapshots, ref)) &&
    proposed.quotedSpans.every(
      (span) =>
        proposed.evidenceRefs.includes(span.ref) &&
        span.quote.trim().length > 0 &&
        snapshots[span.ref]?.includes(span.quote),
    )
  );
}
