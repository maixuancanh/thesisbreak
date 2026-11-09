import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
const owner = z.string().trim().min(1).max(200);
export const cohortExportOptions = z
  .object({
    user: owner,
    namespace: z.string().regex(/^(live|replay:[A-Za-z0-9_-]+)$/),
    method: z.string().min(1).max(200),
    horizon: z.enum(["T24h", "T60m"]),
    asOf: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export function reportOutputPath(input: string) {
  const base = resolve(".local"),
    output = resolve(input),
    child = relative(base, output);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child) ||
    !child.endsWith(".json")
  )
    throw Error("PRIVATE_REPORT_PATH_REQUIRED");
  return output;
}
export async function writePrivateReport(path: string, report: unknown) {
  const output = reportOutputPath(path),
    base = resolve(".local");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const root = await realpath(base),
    parent = await realpath(dirname(output)),
    child = relative(root, parent);
  const rootWithinWorkspace = relative(await realpath(process.cwd()), root);
  if (
    rootWithinWorkspace === ".." ||
    rootWithinWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(rootWithinWorkspace) ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  )
    throw Error("PRIVATE_REPORT_PATH_REQUIRED");
  const bytes = JSON.stringify(report, null, 2) + "\n";
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: Buffer.byteLength(bytes),
  };
}
export function publicEvidenceUrl(value: unknown): string | null {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "https:") return null;
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function readSnapshot<T>(
  pool: Pool,
  user: string,
  read: (client: PoolClient, now: string) => Promise<T>,
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (
      !(await c.query("SELECT 1 FROM users WHERE id=$1", [owner.parse(user)]))
        .rowCount
    )
      throw Error("OWNER_NOT_FOUND");
    const now = (
      await c.query("SELECT clock_timestamp() AS now")
    ).rows[0].now.toISOString();
    const result = await read(c, now);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
/** Bounded owner cohort, one real ledger namespace/method/horizon; never exports raw payloads. */
export async function exportForecastCohort(
  pool: Pool,
  raw: z.input<typeof cohortExportOptions>,
) {
  const input = cohortExportOptions.parse(raw);
  return readSnapshot(pool, input.user, async (c, checkedAt) => {
    const asOf = input.asOf ?? checkedAt;
    if (Date.parse(asOf) > Date.parse(checkedAt))
      throw Error("FUTURE_AS_OF_FORBIDDEN");
    const rows = (
      await c.query(
        `SELECT f.id,f.event_id,f.horizon,f.method_version,f.scheduled_at,f.captured_at,f.request_hash,f.payload,r.id AS result_id,r.revision,r.recorded_at AS result_recorded_at,r.payload AS result
      FROM nba_forecasts f LEFT JOIN LATERAL(SELECT id,revision,recorded_at,payload FROM nba_forecast_results WHERE user_id=f.user_id AND namespace=f.namespace AND event_id=f.event_id AND recorded_at<=$5 ORDER BY revision DESC LIMIT 1) r ON true
      WHERE f.user_id=$1 AND f.namespace=$2 AND f.method_version=$3 AND f.horizon=$4 AND f.captured_at<=$5 ORDER BY f.captured_at,f.id LIMIT 10001`,
        [input.user, input.namespace, input.method, input.horizon, asOf],
      )
    ).rows;
    if (rows.length > 10000) throw Error("COHORT_LIMIT_EXCEEDED_NARROW_SCOPE");
    const samples = rows.map((r) => {
      const p = r.payload ?? {},
        result = r.result ?? {};
      const probability =
        typeof p.probability === "number" &&
        Number.isFinite(p.probability) &&
        p.probability >= 0 &&
        p.probability <= 1
          ? p.probability
          : null;
      const sourceUrl = publicEvidenceUrl(result.sourceUrl),
        official =
          !!sourceUrl &&
          new URL(sourceUrl).hostname.match(/(^|\.)nba\.com$/) !== null &&
          result.verifiedOfficial === true;
      const validLabel =
        official &&
        result.status === "final" &&
        [p.homeTeam, p.awayTeam].includes(result.winner) &&
        typeof result.winner === "string" &&
        Number.isFinite(Date.parse(result.retrievedAt)) &&
        Date.parse(result.retrievedAt) <= Date.parse(asOf) &&
        new Date(r.result_recorded_at).getTime() >
          new Date(r.captured_at).getTime();
      return {
        forecastId: r.id,
        eventId: r.event_id,
        horizon: r.horizon,
        methodVersion: r.method_version,
        modelVersion:
          typeof p.modelVersion === "string" ? p.modelVersion : null,
        procedureVersion:
          typeof p.procedureVersion === "string" ? p.procedureVersion : null,
        scheduledAt: r.scheduled_at,
        capturedAt: r.captured_at,
        outcome: {
          homeTeam: p.homeTeam ?? null,
          awayTeam: p.awayTeam ?? null,
          orientation: "home_win",
        },
        probability,
        baselineProbability:
          typeof p.baselineProbability === "number" &&
          Number.isFinite(p.baselineProbability) &&
          p.baselineProbability >= 0 &&
          p.baselineProbability <= 1
            ? p.baselineProbability
            : null,
        baselineProvenance: {
          timestamp: null,
          method: null,
          normalization: null,
          status: "not_retained_in_standard_forecast_payload",
        },
        disposition:
          probability !== null
            ? "predicted"
            : p.abstentionReason
              ? "abstained"
              : "unavailable",
        abstentionReasonHash: p.abstentionReason
          ? digest(p.abstentionReason)
          : null,
        requestHash: r.request_hash,
        payloadHash: digest(p),
        evidence: Array.isArray(p.evidence)
          ? p.evidence.map((e: Record<string, unknown>) => ({
              url: publicEvidenceUrl(e.url),
              publishedAt: e.publishedAt ?? null,
              retrievedAt: e.retrievedAt ?? null,
              contentHash: e.contentHash ?? null,
            }))
          : [],
        result: r.result_id
          ? {
              id: r.result_id,
              revision: r.revision,
              recordedAt: r.result_recorded_at,
              retrievedAt: result.retrievedAt ?? null,
              sourceUrl,
              payloadHash: digest(result),
              official,
              usableLabel: validLabel,
              label: validLabel ? Number(result.winner === p.homeTeam) : null,
            }
          : null,
      };
    });
    const settled = samples.filter((s) => s.result?.usableLabel),
      predicted = settled.filter((s) => s.probability !== null),
      paired = predicted.filter((s) => s.baselineProbability !== null);
    const selection = {
      ownerId: input.user,
      namespace: input.namespace,
      method: input.method,
      horizon: input.horizon,
      asOf,
    };
    return {
      schemaVersion: 1,
      kind: "forecast_cohort_export",
      checkedAt,
      selection,
      selectionHash: digest(selection),
      samplesHash: digest(samples),
      mode:
        input.namespace === "live" ? "prospective_ledger" : "historical_replay",
      counts: {
        capturedForecasts: samples.length,
        capturedEvents: new Set(samples.map((s) => s.eventId)).size,
        settledUsableForecasts: settled.length,
        predictedSettled: predicted.length,
        pairedSettled: paired.length,
        unresolvedOrUnusable: samples.length - settled.length,
        abstained: samples.filter((s) => s.disposition === "abstained").length,
        unavailable: samples.filter((s) => s.disposition === "unavailable")
          .length,
      },
      denominators: {
        modelCoverage: settled.length,
        pairedCoverage: settled.length,
        scheduledEvents: null,
        missedScheduledCaptures: null,
      },
      limitations: [
        "Captured ledger coverage only; missing scheduled events require separate schedule inventory.",
        "Live namespace identifies ledger mode, not independent proof of prospective study preregistration.",
        "No raw rationale, private chat, model configuration or URL query credentials exported.",
        "Source timestamps and retained hashes require independent provenance verification.",
      ],
      samples,
    };
  });
}
export async function auditStrengthening(
  pool: Pool,
  user: string,
  env: Readonly<Record<string, string | undefined>>,
) {
  return readSnapshot(pool, user, async (c, checkedAt) => {
    const query = async (sql: string) => (await c.query(sql, [user])).rows;
    const research = await query(
      "SELECT kind,state,count(*)::int AS count,min(recorded_at) AS oldest_recorded_at,min(lease_until) FILTER(WHERE state='processing') AS earliest_lease_until FROM research_jobs WHERE user_id=$1 GROUP BY kind,state ORDER BY kind,state",
    );
    const challenger = await query(
      "SELECT state,count(*)::int AS count,min(created_at) AS oldest_created_at FROM nba_challenger_jobs WHERE user_id=$1 GROUP BY state ORDER BY state",
    );
    const subscription = await query(
      "SELECT enabled,memory_consent,challenger_consent,updated_at FROM nba_forecast_subscriptions WHERE user_id=$1",
    );
    const health = await query(
      "SELECT last_started_at,last_success_at,last_failed_at FROM research_worker_health WHERE user_id=$1",
    );
    const clocks = (
      await c.query(
        "SELECT job,last_started_at,last_success_at,last_failed_at,lease_until FROM forecast_worker_health WHERE job=ANY($1::text[]) ORDER BY job",
        [
          [
            "nba.capture.cloudflare",
            "nba.maintenance",
            "memory.index.materialize",
            "nba.challenger",
          ],
        ],
      )
    ).rows;
    const index = (
      await query(
        "SELECT count(*)::int AS edges,max(indexed_at) AS last_indexed_at,max(recorded_at) AS latest_source_recorded_at,EXTRACT(epoch FROM (clock_timestamp()-max(indexed_at))) AS seconds_since_index_refresh FROM memory_index_edges WHERE owner_id=$1",
      )
    )[0];
    const grants = await query(
      "SELECT authority_kind,revoked_at IS NOT NULL AS revoked,count(*)::int AS count FROM research_artifact_memory_grants WHERE owner_id=$1 GROUP BY authority_kind,revoked_at IS NOT NULL ORDER BY authority_kind,revoked",
    );
    const publications = await query(
      "SELECT state,count(*)::int AS count,count(*) FILTER(WHERE receipt IS NOT NULL)::int AS receipt_count,count(*) FILTER(WHERE fresh_verified_at IS NOT NULL)::int AS fresh_read_count FROM research_artifact_memory_publications WHERE owner_id=$1 GROUP BY state ORDER BY state",
    );
    const watches = await query(
      "SELECT state,count(*)::int AS count,min(last_success_at) AS oldest_last_success_at,count(*) FILTER(WHERE last_error IS NOT NULL)::int AS error_count FROM source_watches WHERE user_id=$1 GROUP BY state ORDER BY state",
    );
    const allowedFlags = [
      "RESEARCH_WORKER_ENABLED",
      "FORECAST_CHALLENGER_MODE",
      "FORECAST_CHALLENGER_ENABLED",
      "GRAPH_RETRIEVAL_MODE",
      "SOURCE_WATCH_ENABLED",
      "DEBATE_MODE",
      "RESEARCH_ARTIFACT_MEMORY_ENABLED",
      "PROCEDURE_VERSION",
    ];
    const safeValues = new Set([
      "true",
      "false",
      "off",
      "shadow",
      "verified",
      "opt_in",
    ]);
    const flags = Object.fromEntries(
      allowedFlags.map((k) => [
        k,
        env[k] === undefined
          ? "unset"
          : safeValues.has(env[k]!)
            ? env[k]
            : "configured_other_value_redacted",
      ]),
    );
    return {
      schemaVersion: 1,
      kind: "strengthening_read_only_audit",
      ownerId: user,
      checkedAt,
      flags,
      subscription: subscription[0] ?? null,
      research,
      challenger,
      researchHealth: health[0] ?? null,
      clocks,
      index,
      grants,
      publications,
      watches,
      limitations: [
        "Flags describe this CLI process; deployed environment may differ.",
        "Index refresh age is not source-to-index lag; pending materialization count is unknown.",
        "Receipt/fresh-read counts are local ledger evidence, not a fresh remote verification or useful-memory total.",
        "No private payloads, watcher URLs, raw error strings, blob IDs, credentials or global reviewer identities included.",
        "No host/UI/Mainnet lifecycle or predictive benefit accepted by this audit.",
      ],
    };
  });
}
