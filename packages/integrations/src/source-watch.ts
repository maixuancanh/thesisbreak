import {
  recordReviewedReportSnapshot,
  type ReviewedReportTarget,
} from "./reviewed-report-watch";
import {
  pollOfficialNbaLineupWatch,
  type OfficialLineupWatchTarget,
} from "./official-lineup-watch";
import type { Pool } from "pg";
import {
  createSourceWatch,
  recordSourceWatchFailure,
  recordSourceWatchSnapshot,
} from "../../db/src/source-watches";
import {
  sourceJsonPointer,
  type SourceWatchInput,
  type SourceSnapshot,
} from "../../domain/src/source-watch";
import {
  fetchSourceText,
  validatePublisherUrl,
  verifySourceWatchNotification,
} from "./changedetection-adapter";

export type SourceWatchConfig = {
  reviewedReportTargets?: Readonly<Record<string, ReviewedReportTarget>>;
  officialLineupTransport?: typeof fetch;
  officialLineupTargets?: Readonly<Record<string, OfficialLineupWatchTarget>>;
  enabled: boolean;
  publisherHosts: readonly string[];
  cap?: number;
  maxChecksPerDay?: number;
  /** Trusted server registration only; upstream watch must already apply the stored selector. */
  readServiceSnapshot?: (
    serviceWatchId: string,
    watch: Record<string, unknown>,
  ) => Promise<SourceSnapshot>;
  fetchText?: typeof fetchSourceText;
};
export async function followSource(
  pool: Pool,
  ownerId: string,
  input: SourceWatchInput,
  config: SourceWatchConfig,
) {
  if (!config.enabled) throw Error("SOURCE_WATCH_DISABLED");
  validatePublisherUrl(input.url, config.publisherHosts);
  if (input.contentClass === "html")
    throw Error("SOURCE_HTML_REQUIRES_SERVICE_REGISTRATION");
  return createSourceWatch(
    pool,
    ownerId,
    input,
    config.cap === undefined ? {} : { cap: config.cap },
  );
}
/** Reserve a polling interval atomically, so concurrent workers cannot multiply fetches. */
export async function pollSourceWatch(
  pool: Pool,
  ownerId: string,
  watchId: string,
  config: SourceWatchConfig,
  notification = false,
) {
  if (!config.enabled) return { status: "disabled" };
  void notification; // A signed notification still obeys the service polling quota.
  const cap = config.maxChecksPerDay ?? 1500;
  if (!Number.isInteger(cap) || cap < 1 || cap > 10000)
    throw Error("INVALID_SOURCE_QUOTA");
  const w = (
    await pool.query(
      `UPDATE source_watches SET next_check_at=clock_timestamp()+poll_seconds*interval '1 second' WHERE id=$1 AND user_id=$2 AND state='active' AND expires_at>clock_timestamp() AND next_check_at<=clock_timestamp() RETURNING *`,
      [watchId, ownerId],
    )
  ).rows[0];
  if (!w) return { status: "inactive_or_not_due" };
  try {
    const budget = await pool.query(
      "INSERT INTO source_watch_daily_budget(day,checks) VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(day) DO UPDATE SET checks=source_watch_daily_budget.checks+1 WHERE source_watch_daily_budget.checks<$1 RETURNING checks",
      [cap],
    );
    if (!budget.rowCount) {
      await pool.query(
        "UPDATE source_watches SET last_error='SOURCE_QUOTA_EXHAUSTED' WHERE id=$1 AND user_id=$2",
        [watchId, ownerId],
      );
      return { status: "quota_exhausted" };
    }
    if (!w.official_target) validatePublisherUrl(w.url, config.publisherHosts);
    const officialTarget =
      w.official_target ?? config.officialLineupTargets?.[w.id];
    if (officialTarget)
      return await pollOfficialNbaLineupWatch(
        pool,
        ownerId,
        watchId,
        officialTarget,
        config.officialLineupTransport,
      );
    let snapshot: SourceSnapshot;
    if (w.content_class === "html") {
      if (!w.service_watch_id || !config.readServiceSnapshot)
        throw Error("SOURCE_SERVICE_UNAVAILABLE");
      snapshot = await config.readServiceSnapshot(w.service_watch_id, w);
    } else {
      const response = await (config.fetchText ?? fetchSourceText)(
        w.url,
        config.publisherHosts,
      );
      // JSON feed/API first. XML feeds require a separately normalized field adapter.
      if (
        !/\b(?:application\/(?:[\w.+-]*\+)?json|text\/json)\b/i.test(
          response.contentType,
        )
      )
        throw Error("SOURCE_CONTENT_CLASS_MISMATCH");
      const reportTarget = config.reviewedReportTargets?.[w.id];
      if (reportTarget)
        return await recordReviewedReportSnapshot(
          pool,
          ownerId,
          watchId,
          JSON.parse(response.text),
          reportTarget,
        );
      snapshot = {
        eventId: w.event_id,
        originId: w.origin_id,
        url: w.url,
        contentClass: w.content_class,
        value: sourceJsonPointer(JSON.parse(response.text), w.selector),
        publishedAt: null,
      };
    }
    return await recordSourceWatchSnapshot(pool, ownerId, watchId, snapshot);
  } catch {
    await recordSourceWatchFailure(pool, ownerId, watchId);
    return { status: "unavailable" };
  }
}
export async function acceptSourceWatchWebhook(
  pool: Pool,
  body: string,
  signature: string,
  secret: string,
  config: SourceWatchConfig,
) {
  if (!config.enabled) throw Error("SOURCE_WATCH_DISABLED");
  const event = verifySourceWatchNotification(body, signature, secret);
  const watch = (
    await pool.query(
      "SELECT id,user_id FROM source_watches WHERE service_watch_id=$1 AND state='active' AND expires_at>clock_timestamp()",
      [event.serviceWatchId],
    )
  ).rows[0];
  if (!watch) throw Error("SOURCE_WATCH_UNKNOWN");
  const inserted = await pool.query(
    "INSERT INTO source_watch_nonces(nonce) VALUES($1) ON CONFLICT DO NOTHING RETURNING nonce",
    [event.nonce],
  );
  if (!inserted.rowCount) throw Error("SOURCE_NOTIFICATION_REPLAY");
  // Authenticated service is read afresh; payload contains no trusted URL or owner.
  return pollSourceWatch(pool, watch.user_id, watch.id, config, true);
}
export async function runSourceWatchBatch(
  pool: Pool,
  config: SourceWatchConfig,
  limit = 5,
) {
  if (!config.enabled) return [];
  if (!Number.isInteger(limit) || limit < 1 || limit > 25)
    throw Error("INVALID_WATCH_BATCH");
  const due = (
    await pool.query(
      "SELECT id,user_id FROM source_watches WHERE state='active' AND expires_at>clock_timestamp() AND next_check_at<=clock_timestamp() ORDER BY next_check_at LIMIT $1",
      [limit],
    )
  ).rows;
  const results = [];
  for (const w of due)
    results.push(await pollSourceWatch(pool, w.user_id, w.id, config));
  return results;
}
