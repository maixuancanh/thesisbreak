import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  buildSourceScore,
  validateSourceScore,
  type SourceScore,
} from "../../domain/src/source-credibility";
import { DomainConflict } from "../../domain/src/proposal";
import { forecastEligibility } from "../../domain/src/forecast";
import { isDeepStrictEqual } from "node:util";
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const time = z.iso.datetime({ offset: true });
const probability = z.number().min(0).max(1).finite().nullable();
const inputSchema = z
  .object({
    platform: z.enum(["kalshi", "polymarket"]),
    nativeId: z.string().min(1).max(128),
    sourceId: z.string().min(1).max(240),
    sourceName: z.string().min(1).max(160),
    kind: z.enum(["market_baseline", "user_reported_forecaster"]),
    cohort: z.string().min(1).max(160),
    outcome: z.string().min(1).max(256),
    probability,
    baselineProbability: probability,
    scheduledAt: time.nullable(),
    reference: z.url().refine((s) => {
      const u = new URL(s);
      return u.protocol === "https:" && !u.username && !u.password;
    }),
    rulesHash: z.string().min(1).max(128),
    memoryConsent: z.boolean(),
  })
  .strict();
type Tx = PoolClient;
async function transaction<T>(pool: Pool, fn: (c: Tx) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
/** Caller holds the profile row lock. Derived grades cannot be supplied by a browser/model. */
async function rebuild(c: Tx, profile: Record<string, unknown>) {
  const rows = (
    await c.query(
      "SELECT *,clock_timestamp() AS checked_at FROM source_forecasts WHERE profile_id=$1 AND user_id=$2 ORDER BY recorded_at DESC,id DESC LIMIT 50",
      [profile.id, profile.user_id],
    )
  ).rows;
  if (!rows.length) return;
  const version = Number(profile.current_version) + 1;
  const payload = buildSourceScore({
    id: String(profile.id),
    userId: String(profile.user_id),
    sourceId: String(profile.source_id),
    sourceName: String(profile.source_name),
    kind: profile.kind as SourceScore["kind"],
    cohort: String(profile.cohort),
    version,
    updatedAt: new Date(rows[0].checked_at).toISOString(),
    forecasts: rows.map((r) => ({
      eventId: `${r.platform}:${r.native_id}`,
      outcome: r.outcome,
      probability: r.probability ?? null,
      baselineProbability: r.baseline_probability ?? null,
      scheduledAt: r.scheduled_at
        ? new Date(r.scheduled_at).toISOString()
        : null,
      recordedAt: new Date(r.recorded_at).toISOString(),
      reference: r.resolution?.reference ?? r.reference,
      resolvedAt: r.resolution?.resolvedAt ?? null,
      winner: r.resolution?.outcome ?? null,
      status: r.resolution?.status ?? "pending",
      revision: r.revision,
    })),
  });
  await c.query(
    "INSERT INTO source_score_versions(profile_id,user_id,version,payload) VALUES($1,$2,$3,$4)",
    [profile.id, profile.user_id, version, JSON.stringify(payload)],
  );
  await c.query("UPDATE source_profiles SET current_version=$2 WHERE id=$1", [
    profile.id,
    version,
  ]);
  if (profile.memory_consent === true && profile.state === "active")
    await c.query(
      "INSERT INTO outbox(operation_key,user_id,kind,payload) VALUES($1,$2,'source.score.created',$3)",
      [
        JSON.stringify(["source", profile.id, version]),
        profile.user_id,
        JSON.stringify({
          sourceProfileId: profile.id,
          version,
          memoryConsent: true,
        }),
      ],
    );
  return payload;
}
/** Trusted server primitive: source quote, event clock and rules must be resolved server-side. */
export async function registerSourceForecast(
  pool: Pool,
  userId: string,
  value: z.input<typeof inputSchema>,
) {
  const x = inputSchema.parse(value);
  return transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `sources:${userId}`,
    ]);
    const id = digest(["source", userId, x.sourceId, x.cohort]);
    let profile = (
      await c.query(
        "SELECT * FROM source_profiles WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [id, userId],
      )
    ).rows[0];
    if (!profile) {
      const count = (
        await c.query(
          "SELECT count(*)::int AS n FROM source_profiles WHERE user_id=$1",
          [userId],
        )
      ).rows[0].n;
      if (count >= 25) throw new DomainConflict("SOURCE_LIMIT_REACHED");
      profile = (
        await c.query(
          "INSERT INTO source_profiles(id,user_id,source_id,source_name,kind,cohort,memory_consent) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            id,
            userId,
            x.sourceId,
            x.sourceName,
            x.kind,
            x.cohort,
            x.memoryConsent,
          ],
        )
      ).rows[0];
    }
    if (profile.state !== "active") throw new DomainConflict("SOURCE_PAUSED");
    const old = (
      await c.query(
        "SELECT * FROM source_forecasts WHERE profile_id=$1 AND platform=$2 AND native_id=$3",
        [id, x.platform, x.nativeId],
      )
    ).rows[0];
    if (old) {
      if (
        old.outcome !== x.outcome ||
        old.probability !== x.probability ||
        old.reference !== x.reference ||
        old.rules_hash !== x.rulesHash
      )
        throw new DomainConflict("SOURCE_FORECAST_LOCKED");
      return { sourceProfileId: id, forecastId: old.id as string };
    }
    const now = (await c.query("SELECT clock_timestamp() AS at")).rows[0].at;
    if (
      forecastEligibility(new Date(now).toISOString(), x.scheduledAt) ===
      "event_started"
    )
      throw new DomainConflict("EVENT_ALREADY_STARTED");
    const forecastId = randomUUID();
    await c.query(
      "INSERT INTO source_forecasts(id,profile_id,user_id,platform,native_id,outcome,probability,baseline_probability,scheduled_at,reference,rules_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        forecastId,
        id,
        userId,
        x.platform,
        x.nativeId,
        x.outcome,
        JSON.stringify(x.probability),
        JSON.stringify(x.baselineProbability),
        x.scheduledAt,
        x.reference,
        x.rulesHash,
      ],
    );
    await rebuild(c, profile);
    return { sourceProfileId: id, forecastId };
  });
}
/** Only a verified official resolver/worker calls this; never expose resolution fields to clients. */
export async function settleSourceForecasts(
  pool: Pool,
  value: {
    platform: "kalshi" | "polymarket";
    nativeId: string;
    rulesHash: string;
    reference: string;
    resolution: { outcome: string; resolvedAt: string } | null;
  },
) {
  const x = z
    .object({
      platform: z.enum(["kalshi", "polymarket"]),
      nativeId: z.string(),
      rulesHash: z.string(),
      reference: z.url(),
      resolution: z
        .object({ outcome: z.string(), resolvedAt: time })
        .nullable(),
    })
    .parse(value);
  const u = new URL(x.reference);
  if (
    x.platform !== "kalshi" ||
    u.protocol !== "https:" ||
    !["kalshi.com", "external-api.kalshi.com"].includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw new Error("UNVERIFIED_RESULT_SOURCE");
  const ids = (
    await pool.query(
      `SELECT DISTINCT profile_id FROM source_forecasts WHERE platform=$1 AND native_id=$2 AND resolution IS DISTINCT FROM CASE WHEN $3::text IS NULL AND resolution IS NULL THEN NULL ELSE jsonb_build_object('outcome',$3::text,'resolvedAt',$4::text,'status',CASE WHEN $3::text IS NULL THEN 'pending' WHEN rules_hash=$5 THEN 'final' ELSE 'disputed' END,'reference',$6::text) END ORDER BY profile_id LIMIT 100`,
      [
        x.platform,
        x.nativeId,
        x.resolution?.outcome ?? null,
        x.resolution?.resolvedAt ?? null,
        x.rulesHash,
        x.reference,
      ],
    )
  ).rows;
  let changed = 0;
  for (const row of ids)
    await transaction(pool, async (c) => {
      const p = (
        await c.query("SELECT * FROM source_profiles WHERE id=$1 FOR UPDATE", [
          row.profile_id,
        ])
      ).rows[0];
      if (!p) return;
      const f = (
        await c.query(
          "SELECT *,clock_timestamp() AS checked_at FROM source_forecasts WHERE profile_id=$1 AND platform=$2 AND native_id=$3",
          [p.id, x.platform, x.nativeId],
        )
      ).rows[0];
      if (!f) return;
      if (
        x.resolution &&
        Date.parse(x.resolution.resolvedAt) > new Date(f.checked_at).getTime()
      )
        throw new Error("FUTURE_RESOLUTION");
      const result = {
        outcome: x.resolution?.outcome ?? null,
        resolvedAt: x.resolution?.resolvedAt ?? null,
        status: !x.resolution
          ? "pending"
          : f.rules_hash === x.rulesHash
            ? "final"
            : "disputed",
        reference: x.reference,
      };
      if (isDeepStrictEqual(f.resolution, result)) return;
      await c.query(
        "UPDATE source_forecasts SET resolution=$2,revision=revision+1 WHERE id=$1",
        [f.id, JSON.stringify(result)],
      );
      await rebuild(c, p);
      changed++;
    });
  return changed;
}
export async function listSourceScores(
  pool: Pool,
  userId: string,
  cohort?: string,
) {
  const rows = (
    await pool.query(
      "SELECT p.id,p.state,p.memory_consent,v.payload,sync.state AS sync_state,sync.durable_reference FROM source_profiles p JOIN source_score_versions v ON v.profile_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version LEFT JOIN LATERAL (SELECT o.state,m.durable_reference FROM outbox o LEFT JOIN memory_records m ON m.logical_id=o.operation_key AND m.user_id=o.user_id WHERE o.user_id=p.user_id AND o.kind='source.score.created' AND o.payload->>'sourceProfileId'=p.id AND o.payload->>'version'=p.current_version::text LIMIT 1) sync ON true WHERE p.user_id=$1 AND ($2::text IS NULL OR p.cohort=$2) ORDER BY p.created_at DESC LIMIT 25",
      [userId, cohort ?? null],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id as string,
    active: r.state === "active",
    memoryConsent: r.memory_consent as boolean,
    payload: validateSourceScore(r.payload),
    syncState: (r.sync_state ?? "not_requested") as string,
    blobId: (r.durable_reference ?? null) as string | null,
  }));
}
export async function controlSource(
  pool: Pool,
  userId: string,
  id: string,
  state: "active" | "paused",
) {
  return transaction(pool, async (c) => {
    const p = (
      await c.query(
        "SELECT * FROM source_profiles WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [id, userId],
      )
    ).rows[0];
    if (!p) throw new Error("NOT_FOUND");
    await c.query(
      "UPDATE source_profiles SET state=$3 WHERE id=$1 AND user_id=$2",
      [id, userId, state],
    );
    if (state === "paused")
      await c.query(
        "UPDATE outbox SET state='blocked',lease_until=NULL WHERE user_id=$1 AND kind='source.score.created' AND payload->>'sourceProfileId'=$2 AND state IN ('pending','retry','processing')",
        [userId, id],
      );
    else if (p.state !== "active") await rebuild(c, { ...p, state });
    return { id, state };
  });
}
