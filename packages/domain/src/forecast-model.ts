import { z } from "zod";

const time = z.iso.datetime({ offset: true });
const probability = z.number().finite().min(0).max(1);
const configSchema = z.object({
  homeAdvantage: z.number().finite().default(65),
  restPointsPerDay: z.number().finite().min(0).max(50).default(0),
  maxRestDifference: z.number().finite().min(0).max(14).default(3),
  k: z.number().finite().positive().max(100).default(20),
  initialRating: z.number().finite().default(1500),
});
export type EloConfig = z.input<typeof configSchema>;
export function eloHomeProbability(
  input: {
    homeRating: number;
    awayRating: number;
    homeRestDays: number;
    awayRestDays: number;
    neutral?: boolean;
  },
  config: EloConfig = {},
) {
  const x = z
    .object({
      homeRating: z.number().finite(),
      awayRating: z.number().finite(),
      homeRestDays: z.number().finite().min(0),
      awayRestDays: z.number().finite().min(0),
      neutral: z.boolean().optional(),
    })
    .parse(input);
  const c = configSchema.parse(config);
  const rest = Math.max(
    -c.maxRestDifference,
    Math.min(c.maxRestDifference, x.homeRestDays - x.awayRestDays),
  );
  return (
    1 /
    (1 +
      10 **
        (-(
          x.homeRating -
          x.awayRating +
          (x.neutral ? 0 : c.homeAdvantage) +
          rest * c.restPointsPerDay
        ) /
          400))
  );
}
const gameSchema = z.object({
  eventId: z.string().min(1),
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  scheduledAt: time,
  resolvedAt: time.nullable(),
  status: z.enum(["final", "pending", "void", "disputed"]),
  homeScore: z.number().int().min(0).nullable(),
  awayScore: z.number().int().min(0).nullable(),
  homeRestDays: z.number().finite().min(0),
  awayRestDays: z.number().finite().min(0),
  neutral: z.boolean().optional(),
});
export type EloGame = z.infer<typeof gameSchema>;
/** Rebuild from information available strictly before asOf. Never accepts unfinished scores. */
export function ratingsBefore(
  games: EloGame[],
  asOf: string,
  config: EloConfig = {},
) {
  time.parse(asOf);
  const cutoff = Date.parse(asOf);
  const c = configSchema.parse(config);
  const ratings: Record<string, number> = Object.create(null) as Record<string, number>;
  const usedEventIds: string[] = [];
  const seen = new Set<string>();
  const parsed = games
    .map((g) => gameSchema.parse(g))
    .sort(
      (a, b) =>
        Date.parse(a.resolvedAt ?? a.scheduledAt) -
          Date.parse(b.resolvedAt ?? b.scheduledAt) ||
        a.eventId.localeCompare(b.eventId),
    );
  for (const g of parsed) {
    if (seen.has(g.eventId)) throw new Error("DUPLICATE_EVENT");
    seen.add(g.eventId);
    if (g.homeTeam === g.awayTeam) throw new Error("INVALID_TEAMS");
    if (
      g.status !== "final" ||
      !g.resolvedAt ||
      Date.parse(g.resolvedAt) >= cutoff ||
      Date.parse(g.scheduledAt) >= cutoff
    )
      continue;
    if (
      Date.parse(g.resolvedAt) <= Date.parse(g.scheduledAt) ||
      g.homeScore === null ||
      g.awayScore === null ||
      g.homeScore === g.awayScore
    )
      throw new Error("INVALID_FINAL_RESULT");
    const h = ratings[g.homeTeam] ?? c.initialRating,
      a = ratings[g.awayTeam] ?? c.initialRating;
    const p = eloHomeProbability(
      {
        homeRating: h,
        awayRating: a,
        homeRestDays: g.homeRestDays,
        awayRestDays: g.awayRestDays,
        ...(g.neutral === undefined ? {} : { neutral: g.neutral }),
      },
      c,
    );
    const delta = c.k * ((g.homeScore > g.awayScore ? 1 : 0) - p);
    ratings[g.homeTeam] = h + delta;
    ratings[g.awayTeam] = a - delta;
    usedEventIds.push(g.eventId);
  }
  return { ratings, usedEventIds, asOf };
}
/** Proportional de-vig for the same bookmaker's simultaneous two-way decimal prices. */
export function devigDecimalOdds(home: number, away: number) {
  z.number().finite().gt(1).parse(home);
  z.number().finite().gt(1).parse(away);
  const h = 1 / home,
    a = 1 / away;
  return {
    homeProbability: h / (h + a),
    awayProbability: a / (h + a),
    overround: h + a - 1,
  };
}
const clamp = (p: number) => Math.max(1e-12, Math.min(1 - 1e-12, p));
export function temperatureProbability(p: number, temperature: number) {
  probability.parse(p);
  z.number().finite().positive().parse(temperature);
  const q = clamp(p);
  return 1 / (1 + Math.exp(-Math.log(q / (1 - q)) / temperature));
}
const sampleSchema = z.object({
  eventId: z.string().min(1),
  recordedAt: time,
  scheduledAt: time,
  resolvedAt: time,
  status: z.enum(["final", "pending", "void", "disputed"]),
  homeWin: z.boolean(),
  probability: probability.nullable(),
  baselineProbability: probability.nullable(),
});
export type EvaluationSample = z.infer<typeof sampleSchema>;
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const loss = (p: number, y: number) =>
  -y * Math.log(clamp(p)) - (1 - y) * Math.log(1 - clamp(p));
function validated(rows: EvaluationSample[]) {
  const seen = new Set<string>();
  return rows
    .map((r) => sampleSchema.parse(r))
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))
    .map((r) => {
      if (seen.has(r.eventId)) throw new Error("DUPLICATE_EVENT");
      seen.add(r.eventId);
      return r;
    });
}
const eligible = (r: EvaluationSample) =>
  r.status === "final" &&
  Date.parse(r.recordedAt) < Date.parse(r.scheduledAt) &&
  Date.parse(r.resolvedAt) > Date.parse(r.scheduledAt);
/** Fit solely on final training labels available before the held-out start. */
export function fitTemporalTemperature(
  train: EvaluationSample[],
  validationStartsAt: string,
) {
  time.parse(validationStartsAt);
  const boundary = Date.parse(validationStartsAt);
  const rows = validated(train);
  if (
    rows.some(
      (r) =>
        Date.parse(r.scheduledAt) >= boundary ||
        Date.parse(r.resolvedAt) >= boundary,
    )
  )
    throw new Error("TEMPORAL_LEAKAGE");
  const usable = rows.filter((r) => eligible(r) && r.probability !== null);
  if (!usable.length) throw new Error("NO_TRAINING_SAMPLES");
  const candidates = Array.from({ length: 81 }, (_, i) =>
    Math.exp(Math.log(0.25) + (i / 80) * Math.log(16)),
  );
  const scored = candidates
    .map((t) => ({
      t,
      l: mean(
        usable.map((r) =>
          loss(temperatureProbability(r.probability!, t), Number(r.homeWin)),
        ),
      )!,
    }))
    .sort((a, b) => a.l - b.l || Math.abs(a.t - 1) - Math.abs(b.t - 1));
  return {
    temperature: scored[0]!.t,
    trainingSamples: usable.length,
    trainingEventIds: usable.map((r) => r.eventId),
    validationStartsAt,
    method: "train-only-grid-temperature-v1" as const,
  };
}
export function evaluateChronological(
  rows: EvaluationSample[],
  calibration?: ReturnType<typeof fitTemporalTemperature>,
) {
  const all = validated(rows);
  if (
    calibration &&
    all.some(
      (r) =>
        Date.parse(r.recordedAt) < Date.parse(calibration.validationStartsAt) ||
        Date.parse(r.scheduledAt) <
          Date.parse(calibration.validationStartsAt) ||
        calibration.trainingEventIds.includes(r.eventId),
    )
  )
    throw new Error("HELDOUT_OVERLAP");
  const settled = all.filter(eligible),
    predicted = settled.filter((r) => r.probability !== null),
    paired = predicted.filter((r) => r.baselineProbability !== null);
  const p = (r: EvaluationSample) =>
    calibration
      ? temperatureProbability(r.probability!, calibration.temperature)
      : r.probability!;
  const differences = paired.map(
    (r) =>
      (r.baselineProbability! - Number(r.homeWin)) ** 2 -
      (p(r) - Number(r.homeWin)) ** 2,
  );
  const improvement = mean(differences);
  // Distribution-free Hoeffding bound for bounded paired Brier differences [-1,1]. Assumes independent events; chronological dependence can invalidate it.
  const radius = paired.length
    ? Math.sqrt((2 * Math.log(40)) / paired.length)
    : null;
  const bins = Array.from({ length: 10 }, (_, i) => {
    const rs = predicted.filter(
      (r) => Math.min(9, Math.floor(p(r) * 10)) === i,
    );
    return {
      lower: i / 10,
      upper: (i + 1) / 10,
      count: rs.length,
      meanProbability: mean(rs.map(p)),
      observedRate: mean(rs.map((r) => Number(r.homeWin))),
    };
  });
  return {
    heldoutAfterTraining: calibration !== undefined,
    events: all.length,
    eligibleEvents: settled.length,
    predictedEvents: predicted.length,
    pairedEvents: paired.length,
    coverage: settled.length ? predicted.length / settled.length : 0,
    pairedCoverage: settled.length ? paired.length / settled.length : 0,
    brier: mean(predicted.map((r) => (p(r) - Number(r.homeWin)) ** 2)),
    logLoss: mean(predicted.map((r) => loss(p(r), Number(r.homeWin)))),
    pairedModelBrier: mean(paired.map((r) => (p(r) - Number(r.homeWin)) ** 2)),
    pairedBaselineBrier: mean(
      paired.map((r) => (r.baselineProbability! - Number(r.homeWin)) ** 2),
    ),
    pairedModelLogLoss: mean(paired.map((r) => loss(p(r), Number(r.homeWin)))),
    pairedBaselineLogLoss: mean(
      paired.map((r) => loss(r.baselineProbability!, Number(r.homeWin))),
    ),
    pairedBrierImprovement: improvement,
    improvementInterval:
      improvement === null || radius === null
        ? null
        : {
            lower: Math.max(-1, improvement - radius),
            upper: Math.min(1, improvement + radius),
            confidence: 0.95,
            assumption:
              "independent distinct events; does not account for temporal dependence",
          },
    calibration: bins,
    eventIds: all.map((r) => r.eventId),
  };
}
export function shadowPromotion(
  evaluation: ReturnType<typeof evaluateChronological>,
  policy = { minimumPairedEvents: 500, minimumCoverage: 0.9 },
) {
  z.number().int().positive().parse(policy.minimumPairedEvents);
  probability.parse(policy.minimumCoverage);
  const reasons: string[] = [];
  if (!evaluation.heldoutAfterTraining)
    reasons.push("heldout_calibration_required");
  if (evaluation.pairedEvents < policy.minimumPairedEvents)
    reasons.push("insufficient_paired_events");
  if (evaluation.pairedCoverage < policy.minimumCoverage)
    reasons.push("insufficient_paired_coverage");
  if (
    !evaluation.improvementInterval ||
    evaluation.improvementInterval.lower <= 0
  )
    reasons.push("uncertain_brier_improvement");
  if (
    evaluation.pairedModelLogLoss === null ||
    evaluation.pairedBaselineLogLoss === null ||
    evaluation.pairedModelLogLoss >= evaluation.pairedBaselineLogLoss
  )
    reasons.push("log_loss_not_improved");
  return {
    status: reasons.length
      ? ("remain_shadow" as const)
      : ("review_candidate" as const),
    reasons,
    predictiveClaim: false as const,
    automaticPromotion: false as const,
  };
}

