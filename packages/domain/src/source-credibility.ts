import { z } from "zod";
import { researchScopeSchema } from "./research-policy";
import { gradeForecast, sourcePerformance } from "./forecast";
const time = z.iso.datetime({ offset: true });
const probability = z.number().finite().min(0).max(1).nullable();
export function sourceCohort(value: {
  category?: string | null | undefined;
  competition?: string | null | undefined;
}) {
  return [value.category ?? "unclassified", value.competition ?? "general"]
    .join(":")
    .slice(0, 160);
}
export const sourceForecastSchema = z
  .object({
    eventId: z.string().min(1),
    outcome: z.string().min(1),
    probability,
    baselineProbability: probability,
    recordedAt: time,
    scheduledAt: time.nullable(),
    resolvedAt: time.nullable(),
    winner: z.string().nullable(),
    status: z.enum(["pending", "final", "void", "disputed"]),
    revision: z.number().int().positive(),
    reference: z.url(),
    scope: researchScopeSchema.optional(),
  })
  .strict();
const scoreInput = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    sourceId: z.string().min(1),
    sourceName: z.string().min(1).max(160),
    kind: z.enum(["market_baseline", "user_reported_forecaster"]),
    cohort: z.string().min(1).max(160),
    version: z.number().int().positive(),
    updatedAt: time,
    forecasts: z.array(sourceForecastSchema).max(50),
    factReviews: z
      .array(
        z.object({
          id: z.string(),
          claim: z.string().max(2000),
          sourceReference: z.url(),
          evidenceReference: z.url(),
          verdict: z.enum(["supported", "refuted", "unclear"]),
          scope: researchScopeSchema,
          reviewedAt: time,
          reviewer: z.literal("account_owner"),
          verification: z.literal("user_review_not_independently_verified"),
        }),
      )
      .max(50)
      .optional(),
  })
  .strict();
export function buildSourceScore(value: z.input<typeof scoreInput>) {
  const x = scoreInput.parse(value);
  if (new Set(x.forecasts.map((f) => f.eventId)).size !== x.forecasts.length)
    throw new Error("DUPLICATE_SOURCE_EVENT");
  return {
    ...x,
    policyVersion: "source-history-v1" as const,
    window: "latest_50_recorded_events" as const,
    performance: sourcePerformance(
      x.forecasts.map((f) => ({
        eventId: f.eventId,
        revision: f.revision,
        grade: gradeForecast(f),
      })),
    ),
  };
}
export type SourceScore = ReturnType<typeof buildSourceScore>;
export function validateSourceScore(value: unknown): SourceScore {
  const raw = z
    .object({
      policyVersion: z.literal("source-history-v1"),
      window: z.literal("latest_50_recorded_events"),
      performance: z.unknown(),
    })
    .passthrough()
    .parse(value);
  const { policyVersion, window, performance, ...input } = raw;
  void policyVersion;
  void window;
  const expected = buildSourceScore(input as z.input<typeof scoreInput>);
  if (canonical(expected.performance) !== canonical(performance))
    throw new Error("FORGED_SOURCE_SCORE");
  return expected;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Remote memory never grants permission or overrides current account versions. */
export function authorizedSourceMemories(
  current: { payload: SourceScore; active: boolean }[],
  records: readonly {
    type: string;
    logicalId: string;
    version: number;
    payload: unknown;
  }[],
  userId: string,
  cohort: string,
) {
  const found: SourceScore[] = [];
  for (const item of current) {
    if (
      !item.active ||
      item.payload.userId !== userId ||
      item.payload.cohort !== cohort
    )
      continue;
    const hits = records.filter(
      (r) =>
        r.type === "source_credibility" &&
        r.logicalId === item.payload.id &&
        r.version === item.payload.version,
    );
    if (!hits.length) continue;
    try {
      const parsed = hits.map((r) => validateSourceScore(r.payload));
      if (parsed.some((p) => canonical(p) !== canonical(item.payload)))
        continue;
      found.push(parsed[0]!);
    } catch {
      /* Untrusted memory is ignored. */
    }
  }
  return found;
}
