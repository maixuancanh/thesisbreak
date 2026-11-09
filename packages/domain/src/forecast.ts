import { z } from "zod";

const time = z.iso.datetime({ offset: true });
export function forecastEligibility(
  recordedAt: string,
  scheduledAt: string | null,
) {
  if (!time.safeParse(recordedAt).success) return "invalid_recording" as const;
  if (!time.safeParse(scheduledAt).success) return "start_unknown" as const;
  return Date.parse(recordedAt) < Date.parse(scheduledAt!)
    ? ("eligible" as const)
    : ("event_started" as const);
}
const probability = z.number().finite().min(0).max(1).nullable();
const inputSchema = z.object({
  eventId: z.string().min(1),
  recordedAt: time,
  scheduledAt: time.nullable(),
  resolvedAt: time.nullable(),
  outcome: z.string().min(1),
  winner: z.string().min(1).nullable(),
  status: z.enum(["final", "pending", "void", "disputed"]),
  probability,
  baselineProbability: probability,
});
export type ForecastInput = z.input<typeof inputSchema>;
export type ForecastGrade = {
  policyVersion: "pregame-binary-v1";
  comparison: "matched" | "did_not_match" | "not_scored";
  reason: string;
  brier: number | null;
  baselineBrier: number | null;
};
/** Probabilities are for the explicitly selected binary outcome, not always YES. */
export function gradeForecast(value: ForecastInput): ForecastGrade {
  const x = inputSchema.parse(value);
  const eligibility = forecastEligibility(x.recordedAt, x.scheduledAt);
  const excluded = (reason: string): ForecastGrade => ({
    policyVersion: "pregame-binary-v1",
    comparison: "not_scored",
    reason,
    brier: null,
    baselineBrier: null,
  });
  if (eligibility !== "eligible") return excluded(eligibility);
  if (x.status !== "final") return excluded(x.status);
  if (
    !x.winner ||
    !x.resolvedAt ||
    Date.parse(x.resolvedAt) <= Date.parse(x.recordedAt) ||
    Date.parse(x.resolvedAt) < Date.parse(x.scheduledAt!)
  )
    return excluded("invalid_finality");
  const y = x.outcome === x.winner ? 1 : 0;
  const brier = x.probability === null ? null : (x.probability - y) ** 2;
  return {
    policyVersion: "pregame-binary-v1",
    comparison: y ? "matched" : "did_not_match",
    reason: "final",
    brier,
    baselineBrier:
      brier === null || x.baselineProbability === null
        ? null
        : (x.baselineProbability - y) ** 2,
  };
}
/** Caller supplies one source/domain cohort. Revisions replace, never accumulate. */
export function sourcePerformance(
  rows: { eventId: string; revision: number; grade: ForecastGrade }[],
) {
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    z.string().min(1).parse(row.eventId);
    z.number().int().positive().parse(row.revision);
    const old = latest.get(row.eventId);
    if (
      old?.revision === row.revision &&
      JSON.stringify(old.grade) !== JSON.stringify(row.grade)
    )
      throw new Error("AMBIGUOUS_REVISION");
    if (!old || row.revision > old.revision) latest.set(row.eventId, row);
  }
  const grades = [...latest.values()].map((r) => r.grade);
  const scored = grades.filter((g) => g.comparison !== "not_scored");
  const probabilities = scored.filter((g) => g.brier !== null);
  const paired = probabilities.filter((g) => g.baselineBrier !== null);
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return {
    policyVersion: "pregame-binary-v1" as const,
    events: latest.size,
    scored: scored.length,
    matched: scored.filter((g) => g.comparison === "matched").length,
    probabilitySamples: probabilities.length,
    pairedSamples: paired.length,
    meanBrier: mean(probabilities.map((g) => g.brier!)),
    meanBaselineBrier: mean(paired.map((g) => g.baselineBrier!)),
    pairedImprovement: mean(paired.map((g) => g.baselineBrier! - g.brier!)),
  };
}
