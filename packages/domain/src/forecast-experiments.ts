import { createHash } from "node:crypto";
import { z } from "zod";
import {
  evaluateChronological,
  fitTemporalTemperature,
  type EvaluationSample,
} from "./forecast-model";

const time = z.iso.datetime({ offset: true });
const id = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const probability = z.number().finite().min(0).max(1);
const artifact = z
  .object({
    url: z.url(),
    text: z.string().min(1),
    sha256: hash,
    publishedAt: time,
    retrievedAt: time,
  })
  .strict();
const evidence = artifact.extend({ id, sourceId: id }).strict();
const eventSchema = z
  .object({
    eventId: id,
    question: id,
    scheduledAt: time,
    recordedAt: time,
    evidence: z.array(evidence).min(1),
    prediction: z
      .object({
        probability: probability.nullable(),
        baselineProbability: probability.nullable(),
        // A frozen original prediction is necessary for predictive scoring. Never infer from prose.
        artifact: artifact.nullable(),
      })
      .strict(),
    label: z
      .object({
        homeWin: z.boolean(),
        resolvedAt: time,
        availableAt: time,
        artifact,
      })
      .strict()
      .nullable(),
  })
  .strict();
export const experimentCorpusSchema = z
  .object({
    version: z.literal(1),
    namespace: z.string().regex(/^forecast-evaluation:[a-z0-9-]+$/),
    mode: z.enum(["prospective", "historical_replay"]),
    importedAt: time,
    selectionNotes: id,
    competition: id,
    events: z.array(eventSchema),
  })
  .strict();
export type ExperimentCorpus = z.infer<typeof experimentCorpusSchema>;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const instant = (value: string) => Date.parse(value);
function checkArtifact(a: z.infer<typeof artifact>, importedAt: string) {
  if (digest(a.text) !== a.sha256) throw new Error("CONTENT_HASH_MISMATCH");
  if (!/^https?:$/.test(new URL(a.url).protocol))
    throw new Error("INVALID_PROVENANCE_URL");
  if (
    instant(a.publishedAt) > instant(a.retrievedAt) ||
    instant(a.retrievedAt) > instant(importedAt)
  )
    throw new Error("INVALID_PROVENANCE_TIME");
}
/** Structural provenance is necessary, not proof that a publisher's timestamp is truthful. Review retained originals. */
export function validateExperimentCorpus(
  input: unknown,
  asOf: string,
): ExperimentCorpus {
  time.parse(asOf);
  const corpus = experimentCorpusSchema.parse(input);
  if (instant(corpus.importedAt) > instant(asOf))
    throw new Error("FUTURE_IMPORT");
  const seen = new Set<string>();
  for (const event of corpus.events) {
    if (seen.has(event.eventId)) throw new Error("DUPLICATE_EVENT");
    seen.add(event.eventId);
    if (instant(event.recordedAt) >= instant(event.scheduledAt))
      throw new Error("LATE_PREDICTION");
    const refs = new Set<string>();
    for (const item of event.evidence) {
      checkArtifact(item, corpus.importedAt);
      if (refs.has(item.id)) throw new Error("DUPLICATE_EVIDENCE");
      refs.add(item.id);
      if (instant(item.publishedAt) > instant(event.recordedAt))
        throw new Error("FUTURE_EVIDENCE");
      if (
        corpus.mode === "prospective" &&
        instant(item.retrievedAt) > instant(event.recordedAt)
      )
        throw new Error("REPLAY_AS_PROSPECTIVE");
    }
    const prediction = event.prediction;
    if (
      prediction.probability !== null ||
      prediction.baselineProbability !== null
    ) {
      if (!prediction.artifact)
        throw new Error("MISSING_PREDICTION_PROVENANCE");
      checkArtifact(prediction.artifact, corpus.importedAt);
      if (instant(prediction.artifact.publishedAt) > instant(event.recordedAt))
        throw new Error("FUTURE_PREDICTION");
      if (
        corpus.mode === "prospective" &&
        instant(prediction.artifact.retrievedAt) > instant(event.recordedAt)
      )
        throw new Error("REPLAY_AS_PROSPECTIVE");
    }
    if (event.label) {
      checkArtifact(event.label.artifact, corpus.importedAt);
      if (
        instant(event.label.resolvedAt) <= instant(event.scheduledAt) ||
        instant(event.label.availableAt) < instant(event.label.resolvedAt) ||
        instant(event.label.artifact.publishedAt) <
          instant(event.label.resolvedAt) ||
        instant(event.label.artifact.publishedAt) >
          instant(event.label.availableAt) ||
        instant(event.label.availableAt) > instant(asOf)
      )
        throw new Error("INVALID_OR_FUTURE_LABEL");
    }
  }
  return corpus;
}

export const rollingPlanSchema = z
  .object({
    model: id,
    promptVersion: id,
    systemPrompt: id,
    questionPrompt: id,
    origins: z.array(time).min(1),
    evaluationEndsAt: time,
    minimumTrainingEvents: z.number().int().positive().default(20),
    // Freeze the protocol before inspecting held-out outputs; CLI does not tune anything.
    preregisteredAt: time,
  })
  .strict();
export type RollingPlan = z.input<typeof rollingPlanSchema>;
function sample(event: ExperimentCorpus["events"][number]): EvaluationSample {
  if (!event.label) throw new Error("MISSING_LABEL");
  return {
    eventId: event.eventId,
    recordedAt: event.recordedAt,
    scheduledAt: event.scheduledAt,
    resolvedAt: event.label.availableAt,
    status: "final",
    homeWin: event.label.homeWin,
    probability: event.prediction.probability,
    baselineProbability: event.prediction.baselineProbability,
  };
}
export function buildRollingExperiment(
  input: unknown,
  planInput: RollingPlan,
  asOf: string,
) {
  const corpus = validateExperimentCorpus(input, asOf);
  const plan = rollingPlanSchema.parse(planInput);
  const origins = plan.origins.map(instant);
  if (
    origins.some((o, i) => i > 0 && o <= origins[i - 1]!) ||
    origins[origins.length - 1]! >= instant(plan.evaluationEndsAt) ||
    instant(plan.preregisteredAt) >= origins[0]!
  )
    throw new Error("INVALID_ROLLING_BOUNDARIES");
  const events = [...corpus.events].sort(
    (a, b) =>
      instant(a.recordedAt) - instant(b.recordedAt) ||
      a.eventId.localeCompare(b.eventId),
  );
  const folds = plan.origins.map((origin, i) => {
    const end = plan.origins[i + 1] ?? plan.evaluationEndsAt;
    const training = events.filter(
      (e) =>
        e.label &&
        instant(e.recordedAt) < instant(origin) &&
        instant(e.scheduledAt) < instant(origin) &&
        instant(e.label.availableAt) < instant(origin) &&
        instant(e.label.artifact.retrievedAt) < instant(origin) &&
        (!e.prediction.artifact ||
          instant(e.prediction.artifact.retrievedAt) < instant(origin)),
    );
    const heldout = events.filter(
      (e) =>
        instant(e.recordedAt) >= instant(origin) &&
        instant(e.recordedAt) < instant(end),
    );
    const usable = training.filter((e) => e.prediction.probability !== null);
    const calibration =
      usable.length >= plan.minimumTrainingEvents
        ? fitTemporalTemperature(usable.map(sample), origin)
        : null;
    const settled = heldout.filter((e) => e.label !== null).map(sample);
    return {
      origin,
      end,
      trainingEventIds: training.map((e) => e.eventId),
      heldoutEventIds: heldout.map((e) => e.eventId),
      unresolvedEvents: heldout.length - settled.length,
      calibration,
      evaluation: calibration
        ? evaluateChronological(settled, calibration)
        : null,
      calibrationStatus: calibration
        ? ("train_only" as const)
        : ("insufficient_training" as const),
    };
  });
  return {
    namespace: corpus.namespace,
    mode: corpus.mode,
    corpusHash: digest(JSON.stringify(corpus)),
    planHash: digest(JSON.stringify(plan)),
    plan,
    folds,
    predictiveClaim: false as const,
    automaticPromotion: false as const,
  };
}

export type AblationBranch = "with_history" | "without_history";
/** Identical target evidence and prompt; the sole intervention is prior finalized source history. No target label enters either input. */
export function buildAblationPairs(
  input: unknown,
  planInput: RollingPlan,
  asOf: string,
) {
  const corpus = validateExperimentCorpus(input, asOf);
  const experiment = buildRollingExperiment(corpus, planInput, asOf);
  const ids = new Set(experiment.folds.flatMap((f) => f.heldoutEventIds));
  return corpus.events
    .filter((e) => ids.has(e.eventId))
    .sort(
      (a, b) =>
        instant(a.recordedAt) - instant(b.recordedAt) ||
        a.eventId.localeCompare(b.eventId),
    )
    .map((target, index) => {
      const sourceIds = new Set(target.evidence.map((e) => e.sourceId));
      const history = corpus.events
        .filter(
          (e) =>
            e.eventId !== target.eventId &&
            e.label &&
            instant(e.scheduledAt) < instant(target.recordedAt) &&
            instant(e.label.availableAt) < instant(target.recordedAt) &&
            instant(e.label.artifact.retrievedAt) <
              instant(target.recordedAt) &&
            e.evidence.every(
              (item) => instant(item.retrievedAt) < instant(target.recordedAt),
            ) &&
            (!e.prediction.artifact ||
              instant(e.prediction.artifact.retrievedAt) <
                instant(target.recordedAt)),
        )
        .map((e) => ({
          eventId: e.eventId,
          evidence: e.evidence.filter((x) => sourceIds.has(x.sourceId)),
          label: e.label,
          prediction: e.prediction,
        }))
        .filter((e) => e.evidence.length > 0);
      const common = {
        question: target.question,
        evidence: target.evidence,
        asOf: target.recordedAt,
      };
      const base = {
        eventId: target.eventId,
        model: experiment.plan.model,
        promptVersion: experiment.plan.promptVersion,
        system: experiment.plan.systemPrompt,
        commonHash: digest(JSON.stringify(common)),
      };
      const branches: AblationBranch[] =
        index % 2
          ? ["without_history", "with_history"]
          : ["with_history", "without_history"];
      return {
        ...base,
        branches: branches.map((branch) => ({
          branch,
          prompt: JSON.stringify({
            instruction: experiment.plan.questionPrompt,
            ...common,
            sourceHistory: branch === "with_history" ? history : [],
          }),
          historyEventIds:
            branch === "with_history" ? history.map((e) => e.eventId) : [],
        })),
      };
    });
}

const score = z.number().int().min(0).max(2);
export const humanReviewSchema = z
  .object({
    eventId: id,
    responseId: id,
    responseHash: hash,
    reviewerId: id,
    reviewedAt: time,
    blinded: z.literal(true),
    human: z.literal(true),
    rubricVersion: z.literal("grounding-v1"),
    grounding: score,
    citations: score,
    uncertainty: score,
    disagreement: score,
    noLeakage: z.boolean(),
    noFabrication: z.boolean(),
    noUnauthorizedChanges: z.boolean(),
    rationale: id,
  })
  .strict();
export const savedResponseSchema = z
  .object({
    eventId: id,
    responseId: id,
    branch: z.enum(["with_history", "without_history"]),
    model: id,
    commonHash: hash,
    promptHash: hash,
    rawResponse: z.string().nullable(),
    responseHash: hash.nullable(),
    error: z.string().nullable(),
    startedAt: time,
    completedAt: time,
  })
  .strict();
export type SavedExperimentResponse = z.infer<typeof savedResponseSchema>;
const average = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function scoreHumanExperiment(
  responseInput: unknown[],
  reviewInput: unknown[],
  minimumPairs = 10,
) {
  z.number().int().min(10).parse(minimumPairs);
  const responses = responseInput.map((r) => savedResponseSchema.parse(r));
  const reviews = reviewInput.map((r) => humanReviewSchema.parse(r));
  const responseIds = new Set<string>();
  const eventBranches = new Set<string>();
  for (const r of responses) {
    if (
      responseIds.has(r.responseId) ||
      eventBranches.has(`${r.eventId}:${r.branch}`)
    )
      throw new Error("DUPLICATE_RESPONSE");
    responseIds.add(r.responseId);
    eventBranches.add(`${r.eventId}:${r.branch}`);
    if (
      instant(r.completedAt) < instant(r.startedAt) ||
      (r.rawResponse !== null && digest(r.rawResponse) !== r.responseHash) ||
      (r.rawResponse === null && r.error === null) ||
      (r.rawResponse !== null && r.error !== null)
    )
      throw new Error("INVALID_SAVED_RESPONSE");
  }
  const reviewed = new Map<string, z.infer<typeof humanReviewSchema>>();
  for (const review of reviews) {
    if (reviewed.has(review.responseId)) throw new Error("DUPLICATE_REVIEW");
    const response = responses.find((r) => r.responseId === review.responseId);
    if (
      !response ||
      response.eventId !== review.eventId ||
      response.error ||
      response.responseHash !== review.responseHash ||
      instant(review.reviewedAt) < instant(response.completedAt)
    )
      throw new Error("UNBOUND_REVIEW");
    reviewed.set(review.responseId, review);
  }
  const eventIds = [...new Set(responses.map((r) => r.eventId))];
  const pairs = eventIds.flatMap((eventId) => {
    const a = responses.find(
      (r) => r.eventId === eventId && r.branch === "with_history",
    );
    const b = responses.find(
      (r) => r.eventId === eventId && r.branch === "without_history",
    );
    if (!a || !b) return [];
    if (a.model !== b.model || a.commonHash !== b.commonHash)
      throw new Error("UNMATCHED_ABLATION");
    const ar = reviewed.get(a.responseId),
      br = reviewed.get(b.responseId);
    if (!ar || !br) return [];
    return [
      {
        eventId,
        groundingDifference: ar.grounding - br.grounding,
        citationDifference: ar.citations - br.citations,
        uncertaintyDifference: ar.uncertainty - br.uncertainty,
        disagreementDifference: ar.disagreement - br.disagreement,
      },
    ];
  });
  const safetyFailures = reviews.filter(
    (r) => !r.noLeakage || !r.noFabrication || !r.noUnauthorizedChanges,
  ).length;
  const improvements = pairs.filter((p) => p.groundingDifference > 0).length;
  const regressions = pairs.filter((p) => p.groundingDifference < 0).length;
  const meanGroundingDifference = average(
    pairs.map((p) => p.groundingDifference),
  );
  // Conservative descriptive bound; serial dependence can invalidate independent-event coverage.
  const radius = pairs.length
    ? Math.sqrt((8 * Math.log(40)) / pairs.length)
    : null;
  const reasons: string[] = [];
  if (pairs.length < minimumPairs)
    reasons.push("insufficient_human_reviewed_pairs");
  if (pairs.length !== eventIds.length)
    reasons.push("incomplete_pairs_or_reviews");
  if (safetyFailures) reasons.push("safety_gate_failed");
  if (
    meanGroundingDifference === null ||
    meanGroundingDifference <= 0 ||
    improvements <= regressions
  )
    reasons.push("no_grounding_improvement");
  if (pairs.some((p) => p.citationDifference < 0))
    reasons.push("citation_regression_requires_review");
  if (pairs.some((p) => p.uncertaintyDifference < 0))
    reasons.push("uncertainty_regression_requires_review");
  if (pairs.some((p) => p.disagreementDifference < 0))
    reasons.push("disagreement_regression_requires_review");
  if (responses.some((r) => r.error !== null))
    reasons.push("generation_failures");
  return {
    status: reasons.length
      ? ("inconclusive" as const)
      : ("preliminary_human_reviewed_signal" as const),
    reasons,
    attemptedEvents: eventIds.length,
    responseAttempts: responses.length,
    failedResponses: responses.filter((r) => r.error !== null).length,
    reviewedResponses: reviews.length,
    reviewedPairs: pairs.length,
    safetyFailures,
    improvements,
    regressions,
    ties: pairs.length - improvements - regressions,
    meanGroundingDifference,
    meanCitationDifference: average(pairs.map((p) => p.citationDifference)),
    meanUncertaintyDifference: average(
      pairs.map((p) => p.uncertaintyDifference),
    ),
    meanDisagreementDifference: average(
      pairs.map((p) => p.disagreementDifference),
    ),
    groundingInterval:
      radius === null || meanGroundingDifference === null
        ? null
        : {
            lower: Math.max(-2, meanGroundingDifference - radius),
            upper: Math.min(2, meanGroundingDifference + radius),
            assumption:
              "independent distinct events; temporal dependence not accounted for",
          },
    pairs,
    predictiveClaim: false as const,
    automaticPromotion: false as const,
  };
}
