import { z } from "zod";
const time = z.iso.datetime({ offset: true });
const probability = z.number().finite().min(0).max(1).nullable();
const sampleSchema = z
  .object({
    eventId: z.string().min(1),
    horizon: z.string().min(1),
    methodVersion: z.string().min(1),
    recordedAt: time,
    scheduledAt: time,
    resolvedAt: time.nullable(),
    availableAt: time.nullable(),
    status: z.enum(["final", "pending", "void", "disputed"]),
    homeWin: z.boolean().nullable(),
    probability,
    baselineProbability: probability,
    predictionStatus: z.enum(["ok", "abstained", "failed"]),
  })
  .strict();
export type ForecastScorecardSample = z.infer<typeof sampleSchema>;
export type ReliabilityBin = {
  lower: number;
  upper: number;
  count: number;
  meanProbability: number | null;
  observedRate: number | null;
};
const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export const SCORECARD_LOGLOSS_EPSILON = 1e-12;
const logLoss = (p: number, y: boolean) => {
  const clipped = Math.max(
    SCORECARD_LOGLOSS_EPSILON,
    Math.min(1 - SCORECARD_LOGLOSS_EPSILON, p),
  );
  return -Math.log(y ? clipped : 1 - clipped);
};
function bins(rows: ForecastScorecardSample[]): ReliabilityBin[] {
  return Array.from({ length: 10 }, (_, index) => {
    const selected = rows.filter(
      (r) => Math.min(9, Math.floor(r.probability! * 10)) === index,
    );
    return {
      lower: index / 10,
      upper: (index + 1) / 10,
      count: selected.length,
      meanProbability: mean(selected.map((r) => r.probability!)),
      observedRate: mean(selected.map((r) => Number(r.homeWin))),
    };
  });
}
function pairedInterval(deltas: number[]) {
  if (deltas.length < 2) return null;
  // Fixed seed makes reporting reproducible. Each resampled unit is one distinct event.
  let state = 0x5f3759df;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const resamples = 2000;
  const values = Array.from({ length: resamples }, () => {
    let total = 0;
    for (let i = 0; i < deltas.length; i++)
      total += deltas[Math.floor(random() * deltas.length)]!;
    return total / deltas.length;
  }).sort((a, b) => a - b);
  return {
    lower: values[49]!,
    upper: values[1949]!,
    confidence: 0.95,
    method: "event-bootstrap-percentile" as const,
    resamples,
    assumption:
      "Distinct events are resampled independently within this fixed method and horizon. Descriptive interval; no correction for temporal dependence, model selection or multiple comparisons.",
  };
}
/** Current-state descriptive report only. One binary outcome/event/method/horizon; no pooled horizon headline. */
export function buildForecastScorecard(
  input: ForecastScorecardSample[],
  asOf: string,
) {
  time.parse(asOf);
  const rows = input
    .map((r) => sampleSchema.parse(r))
    .sort((a, b) => a.eventId.localeCompare(b.eventId));
  const seen = new Set<string>();
  const cohort = rows[0];
  for (const row of rows) {
    if (
      row.methodVersion !== cohort?.methodVersion ||
      row.horizon !== cohort?.horizon
    )
      throw Error("MIXED_SCORECARD_COHORT");
    if (seen.has(row.eventId)) throw Error("DUPLICATE_EVENT");
    seen.add(row.eventId);
    if ((row.probability !== null) !== (row.predictionStatus === "ok"))
      throw Error("INVALID_PREDICTION_STATUS");
    if (
      Date.parse(row.recordedAt) >= Date.parse(row.scheduledAt) ||
      Date.parse(row.recordedAt) > Date.parse(asOf)
    )
      throw Error("LATE_FORECAST");
    if (
      row.status === "final" &&
      (!row.resolvedAt ||
        !row.availableAt ||
        row.homeWin === null ||
        Date.parse(row.resolvedAt) <= Date.parse(row.scheduledAt) ||
        Date.parse(row.availableAt) < Date.parse(row.resolvedAt))
    )
      throw Error("INVALID_LABEL_TIMELINE");
  }
  const settled = rows.filter(
    (r) =>
      r.status === "final" && Date.parse(r.availableAt!) <= Date.parse(asOf),
  );
  const predicted = settled.filter((r) => r.probability !== null);
  const baselines = settled.filter((r) => r.baselineProbability !== null);
  const paired = predicted.filter((r) => r.baselineProbability !== null);
  const reliability = bins(predicted);
  const deltas = paired.map(
    (r) =>
      (r.probability! - Number(r.homeWin)) ** 2 -
      (r.baselineProbability! - Number(r.homeWin)) ** 2,
  );
  const dates = rows
    .map((r) => r.scheduledAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    schemaVersion: 1 as const,
    asOf,
    methodVersion: cohort?.methodVersion ?? null,
    horizon: cohort?.horizon ?? null,
    status:
      settled.length < 100
        ? ("insufficient_settled_events" as const)
        : ("descriptive_only" as const),
    range: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
    counts: {
      capturedEvents: rows.length,
      settledEvents: settled.length,
      predictedEvents: predicted.length,
      baselineEvents: baselines.length,
      pairedEvents: paired.length,
      abstainedEvents: rows.filter((r) => r.predictionStatus === "abstained")
        .length,
      failedEvents: rows.filter((r) => r.predictionStatus === "failed").length,
      settledWithoutForecast: settled.length - predicted.length,
      unresolvedEvents: rows.filter((r) => r.status === "pending").length,
      excludedResults: rows.filter(
        (r) => r.status === "void" || r.status === "disputed",
      ).length,
      unavailableLabels: rows.filter(
        (r) =>
          r.status === "final" && Date.parse(r.availableAt!) > Date.parse(asOf),
      ).length,
      missingBaselines: settled.length - baselines.length,
      missingScheduledEvents: null,
    },
    coverage: {
      model: settled.length ? predicted.length / settled.length : null,
      paired: settled.length ? paired.length / settled.length : null,
      denominator: settled.length,
    },
    model: {
      events: predicted.length,
      brier: mean(
        predicted.map((r) => (r.probability! - Number(r.homeWin)) ** 2),
      ),
      logLoss: mean(predicted.map((r) => logLoss(r.probability!, r.homeWin!))),
      ece: predicted.length
        ? reliability.reduce(
            (total, b) =>
              total +
              (b.count / predicted.length) *
                Math.abs((b.meanProbability ?? 0) - (b.observedRate ?? 0)),
            0,
          )
        : null,
    },
    baseline: {
      events: baselines.length,
      brier: mean(
        baselines.map((r) => (r.baselineProbability! - Number(r.homeWin)) ** 2),
      ),
      logLoss: mean(
        baselines.map((r) => logLoss(r.baselineProbability!, r.homeWin!)),
      ),
    },
    paired: {
      events: paired.length,
      modelBrier: mean(
        paired.map((r) => (r.probability! - Number(r.homeWin)) ** 2),
      ),
      baselineBrier: mean(
        paired.map((r) => (r.baselineProbability! - Number(r.homeWin)) ** 2),
      ),
      modelLogLoss: mean(
        paired.map((r) => logLoss(r.probability!, r.homeWin!)),
      ),
      baselineLogLoss: mean(
        paired.map((r) => logLoss(r.baselineProbability!, r.homeWin!)),
      ),
      brierDelta: mean(deltas),
      interval: pairedInterval(deltas),
    },
    reliability,
    improvementDemonstrated: false as const,
    protocol: {
      unit: "One distinct event in one fixed method/horizon cohort. Horizons and methods are reported separately.",
      baseline:
        "Saved baseline probability at the same checkpoint; no current market price substitution.",
      coverage:
        "Predicted and paired counts divided by settled captured events. Missed scheduled captures are unknown without a separate schedule inventory.",
      statusThreshold:
        "100 settled events is a display threshold, not a statistical power or improvement guarantee.",
      logLossEpsilon: SCORECARD_LOGLOSS_EPSILON,
    },
  };
}
export type ForecastScorecard = ReturnType<typeof buildForecastScorecard>;
