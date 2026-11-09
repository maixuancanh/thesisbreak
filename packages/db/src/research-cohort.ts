import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { enqueueTypedResearchJob } from "./research-jobs";
import type { ResearchEnvelope } from "../../domain/src/strengthening-contracts";
import { researchInputSchema } from "./research-inputs";
const iso = (v: string | Date) => new Date(v).toISOString();
type LedgerRow = {
  id: string;
  event_id: string;
  horizon: string;
  method_version: string;
  captured_at: string | Date;
  result_recorded_at: string | Date;
  revision: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
};
export function canonicalResearchRows(rows: LedgerRow[], asOf: string) {
  const primary = new Set<string>();
  return rows.flatMap((r) => {
    const p = r.payload,
      result = r.result,
      availableAt = iso(r.result_recorded_at),
      cutoffAt = iso(r.captured_at);
    let source: URL | null = null;
    try {
      source =
        typeof result.sourceUrl === "string" ? new URL(result.sourceUrl) : null;
    } catch {
      return [];
    }
    if (
      result.status !== "final" ||
      result.verifiedOfficial !== true ||
      !source ||
      source.protocol !== "https:" ||
      !(
        source.hostname === "nba.com" || source.hostname.endsWith(".nba.com")
      ) ||
      typeof p.probability !== "number" ||
      !Number.isFinite(p.probability) ||
      p.probability < 0 ||
      p.probability > 1 ||
      typeof result.winner !== "string" ||
      ![p.homeTeam, p.awayTeam].includes(result.winner) ||
      !Number.isFinite(Date.parse(String(result.retrievedAt))) ||
      Date.parse(availableAt) > Date.parse(asOf) ||
      Date.parse(availableAt) <= Date.parse(cutoffAt) ||
      Date.parse(String(result.retrievedAt)) > Date.parse(asOf)
    )
      return [];
    const streamKey = `${r.event_id}:${r.method_version}`;
    const isPrimary = !primary.has(streamKey);
    primary.add(streamKey);
    return [
      {
        forecastId: r.id,
        eventId: r.event_id,
        outcomeVersion: r.revision,
        challengerVersion: r.method_version,
        availableAt,
        cutoffAt,
        probability: p.probability,
        label: result.winner === p.homeTeam ? (1 as const) : (0 as const),
        league: "NBA",
        marketType: "winner",
        horizon: r.horizon,
        primary: isPrimary,
      },
    ];
  });
}

/** One bounded live method/horizon cohort per invocation, rebuilt on result corrections. */
export async function scheduleResearchCohort(pool: Pool, ownerId: string) {
  const asOf = iso(
    (await pool.query("SELECT clock_timestamp() AS t")).rows[0].t,
  );
  const consent = await pool.query(
    "SELECT 1 FROM nba_forecast_subscriptions WHERE user_id=$1 AND enabled=true AND memory_consent=true",
    [ownerId],
  );
  if (!consent.rowCount)
    return { scheduled: 0, reason: "consent_or_subscription_required" };
  const scope = (
    await pool.query(
      `SELECT method_version,horizon FROM nba_forecasts WHERE user_id=$1 AND namespace='live' AND memory_consent=true AND captured_at<$2 ORDER BY captured_at DESC,id LIMIT 1`,
      [ownerId, asOf],
    )
  ).rows[0];
  if (!scope) return { scheduled: 0, reason: "no_live_forecasts" };
  const records = (
    await pool.query(
      `SELECT f.*,r.payload AS result,r.recorded_at AS result_recorded_at,r.revision FROM nba_forecasts f
    JOIN LATERAL (SELECT * FROM nba_forecast_results WHERE user_id=f.user_id AND namespace=f.namespace AND event_id=f.event_id AND recorded_at<=$2 ORDER BY revision DESC LIMIT 1) r ON true
    WHERE f.user_id=$1 AND f.namespace='live' AND f.memory_consent=true AND f.method_version=$3 AND f.horizon=$4 AND f.captured_at<$2
    ORDER BY f.captured_at DESC,f.id LIMIT 500`,
      [ownerId, asOf, scope.method_version, scope.horizon],
    )
  ).rows as LedgerRow[];
  records.reverse();
  const rows = canonicalResearchRows(records, asOf);
  if (!rows.length)
    return { scheduled: 0, reason: "no_eligible_official_results" };
  const digest = createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
  const first = records.find((r) => r.id === rows[0]!.forecastId)!;
  const evidence = Array.isArray(first.payload.evidence)
    ? (first.payload.evidence as Record<string, unknown>[])
    : [];
  if (!evidence.length) return { scheduled: 0, reason: "evidence_required" };
  // Deadline and as-of belong to a stable UTC day snapshot for idempotent cron retries.
  // Content digest changes whenever an official result revision changes.
  const deadlineAt = new Date(
    Date.parse(asOf.slice(0, 10) + "T00:00:00Z") + 2 * 86400000,
  ).toISOString();
  let scheduled = 0;
  for (const operation of [
    "calibration",
    "online_learning",
    "calibration_experiment",
  ] as const) {
    const experimental =
      operation === "calibration_experiment"
        ? chronologicalCalibrationCohort(rows, asOf)
        : null;
    if (operation === "calibration_experiment" && !experimental) continue;
    const operationKey = `${operation}:${digest}`;
    // Skip existing cohorts without changing their frozen as-of timestamp or deadline.
    if (
      (
        await pool.query(
          "SELECT 1 FROM research_jobs WHERE user_id=$1 AND namespace='live' AND kind=$2 AND operation_key=$3",
          [ownerId, operation, operationKey],
        )
      ).rowCount
    )
      continue;
    const jobId = createHash("sha256")
      .update(`${ownerId}:${operationKey}`)
      .digest("hex");
    const payload: ResearchEnvelope = {
      schemaVersion: 1,
      jobId,
      namespace: "live",
      mode: "prospective",
      ownerId,
      eventId: first.event_id,
      marketId: "NBA:winner",
      outcomeId: String(first.payload.homeTeam),
      cutoffAt: iso(first.captured_at),
      eventStartAt: iso(first.payload.scheduledAt as string),
      modelVersion: String(first.payload.modelVersion),
      procedureVersion: first.method_version,
      maxCalls: 1,
      maxOutputTokens: 2000,
      evidence: evidence.map((e, i) => ({
        id: `source-${i}`,
        sha256:
          typeof e.contentHash === "string"
            ? e.contentHash
            : createHash("sha256").update(JSON.stringify(e)).digest("hex"),
        originId: new URL(String(e.url)).hostname,
        url: String(e.url),
        observedAt: iso(e.retrievedAt as string),
        availableAt: iso(e.retrievedAt as string),
        publishedAt: e.publishedAt ? iso(e.publishedAt as string) : null,
        eventId: first.event_id,
      })),
    };
    const artifact = researchInputSchema.parse(
      operation === "calibration_experiment"
        ? { operation, payload: experimental }
        : operation === "calibration"
          ? {
              operation,
              payload: {
                probabilities: rows.map((r) => r.probability),
                labels: rows.map((r) => r.label),
                bins: 10,
              },
            }
          : {
              operation,
              payload: {
                rows,
                asOf: rows
                  .map((r) => r.availableAt)
                  .sort()
                  .at(-1)!,
              },
            },
    );
    await enqueueTypedResearchJob(pool, {
      ownerId,
      operationKey,
      payload,
      artifact,
      deadlineAt,
    });
    scheduled++;
  }
  return { scheduled, samples: rows.length, inputPrefixHash: digest };
}

/** Fixed split policy; ties stay in one temporal block, never move labels backwards. */
export function chronologicalCalibrationCohort(
  rows: ReturnType<typeof canonicalResearchRows>,
  asOf: string,
) {
  const unique = new Map<string, (typeof rows)[number]>();
  for (const row of rows)
    if (!unique.has(row.eventId)) unique.set(row.eventId, row);
  const sorted = [...unique.values()].sort(
    (a, b) =>
      a.availableAt.localeCompare(b.availableAt) ||
      a.eventId.localeCompare(b.eventId),
  );
  if (sorted.length < 170) return null;
  let first = Math.floor(sorted.length * 0.6),
    second = Math.floor(sorted.length * 0.8);
  while (
    first < sorted.length &&
    sorted[first - 1]!.availableAt === sorted[first]!.availableAt
  )
    first++;
  second = Math.max(second, first);
  while (
    second < sorted.length &&
    sorted[second - 1]!.availableAt === sorted[second]!.availableAt
  )
    second++;
  const train = sorted.slice(0, first),
    validation = sorted.slice(first, second),
    heldout = sorted.slice(second);
  if (train.length < 100 || validation.length < 20 || heldout.length < 20)
    return null;
  return {
    train,
    validation,
    heldout,
    fitAt: train.at(-1)!.availableAt,
    selectionAt: validation.at(-1)!.availableAt,
    asOf,
    methods: ["logistic", "beta", "isotonic"],
  };
}
