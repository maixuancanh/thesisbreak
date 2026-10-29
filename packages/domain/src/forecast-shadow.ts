import {
  evaluateChronological,
  fitTemporalTemperature,
  temperatureProbability,
  shadowPromotion,
  type EvaluationSample,
} from "./forecast-model";
/** Candidate calibration is evaluated out-of-sample at each forecast time, never applied to saved forecasts. */
export function evaluateRollingShadow(
  samples: EvaluationSample[],
  minimumTraining = 20,
) {
  if (!Number.isInteger(minimumTraining) || minimumTraining < 20)
    throw Error("MINIMUM_TRAINING_20");
  evaluateChronological(samples);
  const ordered = [...samples].sort(
    (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt),
  );
  const decisions = ordered.map((target) => {
    const train = ordered.filter(
      (r) =>
        r.eventId !== target.eventId &&
        r.status === "final" &&
        r.probability !== null &&
        Date.parse(r.recordedAt) < Date.parse(target.recordedAt) &&
        Date.parse(r.resolvedAt) < Date.parse(target.recordedAt),
    );
    if (train.length < minimumTraining || target.probability === null)
      return {
        eventId: target.eventId,
        temperature: null,
        trainingEventIds: [] as string[],
        probability: null,
      };
    const fit = fitTemporalTemperature(train, target.recordedAt);
    return {
      eventId: target.eventId,
      temperature: fit.temperature,
      trainingEventIds: fit.trainingEventIds,
      probability: temperatureProbability(target.probability, fit.temperature),
    };
  });
  const shadow = evaluateChronological(
    ordered.map((target, i) => ({
      ...target,
      probability: decisions[i]!.probability,
      baselineProbability: target.probability,
    })),
  );
  // Every non-null candidate was fitted solely on labels available before that target's recordedAt.
  const evaluated = {
    ...shadow,
    heldoutAfterTraining: decisions.some((d) => d.temperature !== null),
  };
  return {
    method: "rolling-temperature-shadow-v1",
    decisions,
    evaluation: evaluated,
    promotion: shadowPromotion(evaluated),
    savedForecastsModified: false,
    predictiveImprovementEstablished: false,
  };
}
