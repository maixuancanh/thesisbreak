import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { gradeForecast } from "../../domain/src/forecast";
import type { MemoryWriter } from "../../integrations/src/memory-sync";

const time = z.iso.datetime({ offset: true });
const namespace = z.string().regex(/^(live|replay:[A-Za-z0-9_-]+)$/);
const evidence = z
  .object({
    url: z.url().refine((v) => new URL(v).protocol === "https:"),
    publishedAt: time,
    retrievedAt: time,
  })
  .strict();
export const nbaForecastInput = z
  .object({
    namespace,
    eventId: z.string().min(1),
    league: z.literal("NBA"),
    horizon: z.enum(["T24h", "T60m"]),
    methodVersion: z.string().min(1),
    modelVersion: z.string().min(1),
    modelConfig: z.record(z.string(), z.json()),
    scheduledAt: time,
    capturedAt: time.optional(),
    windowMinutes: z.number().finite().min(0).max(15).default(5),
    homeTeam: z.string().min(1),
    awayTeam: z.string().min(1),
    probability: z.number().finite().min(0).max(1).nullable(),
    baselineProbability: z.number().finite().min(0).max(1).nullable(),
    abstentionReason: z.string().min(1).nullable(),
    evidence: z.array(evidence).min(1),
    memoryConsent: z.boolean().default(false),
  })
  .strict();
export type NbaForecastInput = z.input<typeof nbaForecastInput>;
type ForecastPayload = z.output<typeof nbaForecastInput>;
const canonical = (x: unknown): string =>
  Array.isArray(x)
    ? `[${x.map(canonical).join(",")}]`
    : x !== null && typeof x === "object"
      ? `{${Object.entries(x)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(",")}}`
      : JSON.stringify(x);
const iso = (x: Date | string) => new Date(x).toISOString();
function validateCapture(x: ForecastPayload, capturedAt: string) {
  if (x.homeTeam === x.awayTeam) throw new Error("INVALID_TEAMS");
  if ((x.probability === null) !== (x.abstentionReason !== null))
    throw new Error("ABSTENTION_REASON_REQUIRED_ONLY_WHEN_ABSTAINING");
  const c = Date.parse(capturedAt),
    s = Date.parse(x.scheduledAt),
    target = s - (x.horizon === "T24h" ? 24 * 3600000 : 3600000);
  if (c >= s || Math.abs(c - target) > x.windowMinutes * 60000)
    throw new Error("OUTSIDE_FORECAST_HORIZON");
  for (const e of x.evidence)
    if (
      Date.parse(e.publishedAt) > c ||
      Date.parse(e.retrievedAt) > c ||
      Date.parse(e.publishedAt) > Date.parse(e.retrievedAt)
    )
      throw new Error("FUTURE_EVIDENCE");
}
export async function captureNbaForecast(
  pool: Pool,
  userId: string,
  input: NbaForecastInput,
) {
  z.string().min(1).parse(userId);
  const x = nbaForecastInput.parse(input);
  if (x.namespace === "live" && x.capturedAt !== undefined)
    throw new Error("LIVE_BACKDATE_FORBIDDEN");
  if (x.namespace !== "live" && !x.capturedAt)
    throw new Error("REPLAY_CAPTURE_REQUIRED");
  const hash = createHash("sha256").update(canonical(x)).digest("hex"),
    c = await pool.connect();
  try {
    await c.query("BEGIN");
    const inserted = await c.query(
      "INSERT INTO nba_forecasts(id,user_id,namespace,event_id,horizon,method_version,scheduled_at,captured_at,payload,request_hash,memory_consent) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,clock_timestamp()),$9,$10,$11) ON CONFLICT(user_id,namespace,event_id,horizon,method_version) DO NOTHING RETURNING *",
      [
        randomUUID(),
        userId,
        x.namespace,
        x.eventId,
        x.horizon,
        x.methodVersion,
        x.scheduledAt,
        x.capturedAt ?? null,
        JSON.stringify(x),
        hash,
        x.memoryConsent,
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await c.query(
          "SELECT * FROM nba_forecasts WHERE user_id=$1 AND namespace=$2 AND event_id=$3 AND horizon=$4 AND method_version=$5",
          [userId, x.namespace, x.eventId, x.horizon, x.methodVersion],
        )
      ).rows[0];
    if (!row || row.request_hash !== hash)
      throw new Error("IMMUTABLE_FORECAST_CONFLICT");
    validateCapture(x, iso(row.captured_at));
    await c.query("COMMIT");
    return {
      id: row.id as string,
      capturedAt: iso(row.captured_at),
      namespace: x.namespace,
    };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const resultSchema = z
  .object({
    namespace,
    eventId: z.string().min(1),
    revision: z.number().int().positive(),
    scheduledAt: time,
    resolvedAt: time.nullable(),
    status: z.enum(["final", "pending", "void", "disputed"]),
    winner: z.string().min(1).nullable(),
    verifiedOfficial: z.literal(true),
    sourceUrl: z.url().refine((v) => {
      const u = new URL(v);
      return (
        u.protocol === "https:" &&
        (u.hostname === "nba.com" || u.hostname.endsWith(".nba.com"))
      );
    }),
    retrievedAt: time,
  })
  .strict();
export type NbaOfficialResultInput = z.input<typeof resultSchema>;
/** Provenance must come from the trusted NBA ingestion path; this function does not fetch/verify a remote URL. */
export async function recordNbaOfficialResult(
  pool: Pool,
  userId: string,
  input: NbaOfficialResultInput,
) {
  const x = resultSchema.parse(input);
  if (
    x.status === "final" &&
    (!x.resolvedAt ||
      !x.winner ||
      Date.parse(x.resolvedAt) < Date.parse(x.scheduledAt))
  )
    throw new Error("INVALID_OFFICIAL_FINAL");
  if (x.resolvedAt && Date.parse(x.resolvedAt) > Date.parse(x.retrievedAt))
    throw new Error("RESULT_BEFORE_RESOLUTION");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const clock = iso(
      (await c.query("SELECT clock_timestamp() AS t")).rows[0].t,
    );
    if (Date.parse(x.retrievedAt) > Date.parse(clock))
      throw new Error("FUTURE_RESULT");
    const fs = (
      await c.query(
        "SELECT payload FROM nba_forecasts WHERE user_id=$1 AND namespace=$2 AND event_id=$3",
        [userId, x.namespace, x.eventId],
      )
    ).rows;
    if (!fs.length) throw new Error("FORECAST_NOT_FOUND");
    for (const f of fs) {
      const p = nbaForecastInput.parse(f.payload);
      if (Date.parse(p.scheduledAt) !== Date.parse(x.scheduledAt))
        throw new Error("RESULT_EVENT_START_MISMATCH");
      if (x.winner && ![p.homeTeam, p.awayTeam].includes(x.winner))
        throw new Error("INVALID_WINNER");
    }
    const ins = await c.query(
      "INSERT INTO nba_forecast_results(id,user_id,namespace,event_id,revision,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,namespace,event_id,revision) DO NOTHING RETURNING id",
      [
        randomUUID(),
        userId,
        x.namespace,
        x.eventId,
        x.revision,
        JSON.stringify(x),
      ],
    );
    if (!ins.rows.length) {
      const existing = (
        await c.query(
          "SELECT payload FROM nba_forecast_results WHERE user_id=$1 AND namespace=$2 AND event_id=$3 AND revision=$4",
          [userId, x.namespace, x.eventId, x.revision],
        )
      ).rows[0];
      if (canonical(existing.payload) !== canonical(x))
        throw new Error("IMMUTABLE_RESULT_CONFLICT");
    }
    await c.query("COMMIT");
    return { status: x.status, revision: x.revision };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function listNbaForecastLedger(
  pool: Pool,
  userId: string,
  scope: string,
) {
  namespace.parse(scope);
  const rows = (
    await pool.query(
      "SELECT f.*,r.payload AS result,m.blob_id,m.hash FROM nba_forecasts f LEFT JOIN LATERAL (SELECT payload FROM nba_forecast_results WHERE user_id=f.user_id AND namespace=f.namespace AND event_id=f.event_id ORDER BY revision DESC LIMIT 1) r ON true LEFT JOIN nba_forecast_memory_receipts m ON m.forecast_id=f.id AND m.version=COALESCE((r.payload->>'revision')::integer+1,1) WHERE f.user_id=$1 AND f.namespace=$2 ORDER BY f.scheduled_at,f.id",
      [userId, scope],
    )
  ).rows;
  return rows.map((r) => {
    const p = nbaForecastInput.parse(r.payload),
      result = r.result ? resultSchema.parse(r.result) : null;
    return {
      id: r.id as string,
      namespace: scope,
      capturedAt: iso(r.captured_at),
      forecast: p,
      result,
      grade: gradeForecast({
        eventId: p.eventId,
        recordedAt: iso(r.captured_at),
        scheduledAt: p.scheduledAt,
        resolvedAt: result?.resolvedAt ?? null,
        status: result?.status ?? "pending",
        outcome: p.homeTeam,
        winner: result?.winner ?? null,
        probability: p.probability,
        baselineProbability: p.baselineProbability,
      }),
      receipt: r.blob_id
        ? { blobId: r.blob_id as string, hash: r.hash as string }
        : null,
    };
  });
}
/** MemWalAdapter.remember performs exact blob/hash readback; only its verified receipt is persisted. */
export async function syncNbaForecastMemory(
  pool: Pool,
  adapter: MemoryWriter,
  userId: string,
  forecastId: string,
) {
  const row = (
    await pool.query("SELECT * FROM nba_forecasts WHERE id=$1 AND user_id=$2", [
      forecastId,
      userId,
    ])
  ).rows[0];
  if (!row) throw new Error("FORECAST_NOT_FOUND");
  if (!row.memory_consent) return { status: "consent_required" as const };
  const result = (
    await pool.query(
      "SELECT payload,recorded_at FROM nba_forecast_results WHERE user_id=$1 AND namespace=$2 AND event_id=$3 ORDER BY revision DESC LIMIT 1",
      [userId, row.namespace, row.event_id],
    )
  ).rows[0];
  const version = result ? Number(result.payload.revision) + 1 : 1;
  const existing = (
    await pool.query(
      "SELECT blob_id,hash FROM nba_forecast_memory_receipts WHERE forecast_id=$1 AND version=$2",
      [forecastId, version],
    )
  ).rows[0];
  if (existing)
    return {
      status: "verified" as const,
      blobId: existing.blob_id as string,
      hash: existing.hash as string,
    };
  const receipt = await adapter.remember({
    logicalId: `nba:${row.namespace}:${forecastId}`,
    type: "nba.forecast",
    version,
    recordedAt: result ? iso(result.recorded_at) : iso(row.captured_at),
    payload: z.json().parse({
      userId,
      forecastId,
      namespace: row.namespace,
      capturedAt: iso(row.captured_at),
      forecast: row.payload,
      result: result?.payload ?? null,
    }),
  });
  if (
    receipt.status !== "verified" ||
    !receipt.blobId ||
    !receipt.hash ||
    !/^[a-f0-9]{64}$/.test(receipt.hash)
  )
    return { status: "retry" as const };
  await pool.query(
    "INSERT INTO nba_forecast_memory_receipts(forecast_id,version,blob_id,hash) VALUES($1,$2,$3,$4) ON CONFLICT(forecast_id,version) DO NOTHING",
    [forecastId, version, receipt.blobId, receipt.hash],
  );
  return {
    status: "verified" as const,
    blobId: receipt.blobId,
    hash: receipt.hash,
  };
}

/** Only current owner-consented live versions with an exact verified blob readback enter agent context. */
export async function recallNbaForecastMemories(
  pool: Pool,
  userId: string,
  recall: (
    query: string,
  ) => Promise<{
    sources: {
      blobId: string;
      record: {
        logicalId: string;
        type: string;
        version: number;
        hash: string;
        payload: unknown;
      };
    }[];
  }>,
  now = new Date(),
) {
  const rows = (
    await pool.query(
      `SELECT f.*,r.payload AS result,m.version,m.hash,m.blob_id FROM nba_forecasts f LEFT JOIN LATERAL (SELECT payload FROM nba_forecast_results WHERE user_id=f.user_id AND namespace=f.namespace AND event_id=f.event_id ORDER BY revision DESC LIMIT 1) r ON true JOIN nba_forecast_memory_receipts m ON m.forecast_id=f.id AND m.version=COALESCE((r.payload->>'revision')::integer+1,1) WHERE f.user_id=$1 AND f.namespace='live' AND f.memory_consent=true AND f.captured_at<$2 ORDER BY f.captured_at DESC LIMIT 4`,
      [userId, now],
    )
  ).rows;
  const accepted: unknown[] = [];
  for (const row of rows) {
    const expected = {
      userId,
      forecastId: row.id,
      namespace: row.namespace,
      capturedAt: iso(row.captured_at),
      forecast: row.payload,
      result: row.result ?? null,
    };
    const response = await recall(JSON.stringify(expected));
    const match = response.sources.find(
      (s) =>
        s.blobId === row.blob_id &&
        s.record.hash === row.hash &&
        s.record.logicalId === `nba:live:${row.id}` &&
        s.record.type === "nba.forecast" &&
        s.record.version === row.version &&
        canonical(s.record.payload) === canonical(expected),
    );
    if (match)
      accepted.push({
        forecastId: row.id,
        version: row.version,
        blobId: row.blob_id,
        forecast: row.payload,
        result: row.result ?? null,
        sampleWarning:
          "A historical result does not establish predictive improvement",
      });
  }
  return accepted;
}
