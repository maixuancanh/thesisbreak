import { explanationReferenceSchema } from "./explanation-review";
import { z } from "zod";
const at = z.iso.datetime({ offset: true });
export const decisionRecapSchema = z
  .object({
    explanationReview: explanationReferenceSchema.optional(),
    id: z.string().min(1),
    ownerId: z.string().min(1),
    pickId: z.string().min(1),
    revision: z.number().int().positive(),
    mode: z.enum(["live", "acceptance_test", "replay", "synthetic"]),
    initialReason: z
      .object({
        text: z.string().max(4000),
        reasonId: z.string().nullable(),
        pickVersion: z.number().int().positive(),
        outcome: z.string(),
        confirmedAt: at,
      })
      .strict(),
    changes: z
      .array(
        z
          .object({
            id: z.string(),
            explanation: z.string().max(4000),
            conditionMet: z.boolean().nullable(),
            evidenceState: z.enum(["supported", "contradicted", "unclear"]),
            beforeRefs: z.array(z.string()).max(100),
            afterRefs: z.array(z.string()).max(100),
            checkedAt: at,
            publishedAt: at.nullable().optional(),
            observedAt: at.nullable().optional(),
          })
          .strict(),
      )
      .max(100),
    choices: z
      .array(
        z
          .object({
            id: z.string(),
            action: z.enum(["keep", "update", "stop_watching"]),
            confirmedAt: at,
            afterEvent: z.boolean().nullable(),
          })
          .strict(),
      )
      .max(100),
    officialResult: z
      .object({
        status: z.enum(["waiting", "final", "not_scored"]),
        winner: z.string().nullable(),
        pickWon: z.boolean().nullable(),
        sourceUrl: z.string().nullable(),
        observedAt: at.nullable(),
        resultRevision: z.number().int().positive().nullable(),
      })
      .strict(),
    conditionOccurred: z.boolean().nullable(),
    eventStartedAt: at.nullable(),
    recordedAt: at,
    predecessorId: z.string().nullable(),
    evidenceRefs: z.array(z.string()).max(500),
  })
  .strict();
export type DecisionRecap = z.infer<typeof decisionRecapSchema>;
/** Outcome scoring and reason-condition evidence are deliberately separate observations. */
export function recapResult(input: {
  pickOutcome: string;
  confirmedAt: string;
  eventStartedAt: string | null;
  settlement: {
    status: "pending" | "final" | "void" | "cancelled";
    winner: string | null;
    verified: boolean;
    rulesMatch: boolean;
    sourceUrl: string;
    observedAt: string;
    revision: number;
  } | null;
}): DecisionRecap["officialResult"] {
  const s = input.settlement;
  if (!s || !s.verified || s.status === "pending")
    return {
      status: "waiting",
      winner: null,
      pickWon: null,
      sourceUrl: null,
      observedAt: null,
      resultRevision: null,
    };
  const start = input.eventStartedAt ? Date.parse(input.eventStartedAt) : NaN;
  const confirmed = Date.parse(input.confirmedAt);
  const scorable =
    s.status === "final" &&
    s.rulesMatch &&
    s.winner !== null &&
    Number.isFinite(start) &&
    Number.isFinite(confirmed) &&
    confirmed < start &&
    Date.parse(s.observedAt) >= start;
  return {
    status: scorable ? "final" : "not_scored",
    winner: s.winner,
    pickWon: scorable ? s.winner === input.pickOutcome : null,
    sourceUrl: s.sourceUrl,
    observedAt: s.observedAt,
    resultRevision: s.revision,
  };
}

/** Rumors and failed checks cannot assert that a user condition occurred, even in retained legacy rows. */
export function recapConditionObservation(input: {
  state: string;
  evidenceState: string;
  conditionMet: boolean | null;
}): boolean | null {
  if (
    !["needs_review", "still_watching"].includes(input.state) ||
    input.evidenceState === "unclear"
  )
    return null;
  return input.conditionMet;
}
