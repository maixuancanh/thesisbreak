import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  newsCheckSchema,
  type NewsCheck,
} from "../../integrations/src/news/collect";
import { changedReasonFacts } from "../../integrations/src/news/mapping";
import type { MonitorClaim } from "./market-monitors";
type Market = { platform: "kalshi" | "polymarket"; nativeId: string };
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export async function readIndependentChecks(
  pool: Pool,
  m: Market,
): Promise<NewsCheck[]> {
  const rows = await pool.query(
    "SELECT value FROM independent_source_checks WHERE platform=$1 AND native_id=$2 ORDER BY source LIMIT 10",
    [m.platform, m.nativeId],
  );
  return rows.rows.flatMap((r) => {
    const p = newsCheckSchema.safeParse(r.value);
    return p.success ? [p.data] : [];
  });
}
export async function saveIndependentChecks(
  pool: Pool,
  m: Market,
  values: NewsCheck[],
  claim?: MonitorClaim,
) {
  const checks = values.slice(0, 10).map((v) => newsCheckSchema.parse(v)),
    c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `news:${m.platform}:${m.nativeId}`,
    ]);
    let watched: { outcome: string; reason: string | null } | undefined;
    if (claim) {
      if (m.platform !== claim.platform || m.nativeId !== claim.nativeId)
        throw new Error("MARKET_CONTEXT_MISMATCH");
      watched = (
        await c.query(
          "SELECT v.outcome,v.reason FROM market_monitors m JOIN picks p ON p.id=m.pick_id AND p.user_id=m.user_id AND p.current_version=m.pick_version JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=m.pick_version WHERE m.id=$1 AND m.user_id=$2 AND m.state='active' AND m.pick_version=$3 AND m.attempts=$4 AND m.lease_until>now() AND m.deadline>now() FOR UPDATE OF p,m",
          [claim.id, claim.userId, claim.pickVersion, claim.attempt],
        )
      ).rows[0];
      if (!watched) {
        await c.query("ROLLBACK");
        return false;
      }
      if (checks.length && !claim.independentNews)
        throw new Error("NEWS_WATCH_NOT_APPROVED");
    }
    for (const check of checks) {
      const previous = (
        await c.query(
          "SELECT value FROM independent_source_checks WHERE platform=$1 AND native_id=$2 AND source=$3",
          [m.platform, m.nativeId, check.source],
        )
      ).rows[0]?.value;
      if (
        previous &&
        Date.parse(previous.checkedAt) > Date.parse(check.checkedAt)
      )
        continue;
      const baseline = claim
        ? (
            await c.query(
              "SELECT value,pick_version FROM independent_watch_baselines WHERE monitor_id=$1 AND source=$2",
              [claim.id, check.source],
            )
          ).rows[0]
        : null;
      if (
        claim &&
        watched &&
        check.source === "nba-official" &&
        check.state === "available" &&
        baseline?.pick_version === claim.pickVersion
      ) {
        const changes = changedReasonFacts(
          baseline.value.items,
          check.items,
          watched.reason ?? "",
        );
        for (const change of changes) {
          const dedupe = hash([
            claim.id,
            claim.pickVersion,
            check.source,
            change.previous.status,
            change.current.player,
            change.current.status,
            change.current.eventDate,
            change.current.id,
            change.current.url,
          ]);
          await c.query(
            "INSERT INTO market_updates(id,monitor_id,user_id,dedupe_key,kind,evidence) VALUES($1,$2,$3,$4,'player_status_changed',$5) ON CONFLICT(dedupe_key) DO NOTHING",
            [
              randomUUID(),
              claim.id,
              claim.userId,
              dedupe,
              JSON.stringify({
                ...change,
                pickVersion: claim.pickVersion,
                reasonChanged: false,
                note: "A named player's reported status changed. Review how it affects your reason; no automatic pick change.",
              }),
            ],
          );
        }
      }
      if (claim && check.state === "available")
        await c.query(
          "INSERT INTO independent_watch_baselines(monitor_id,source,pick_version,value) VALUES($1,$2,$3,$4) ON CONFLICT(monitor_id,source) DO UPDATE SET pick_version=EXCLUDED.pick_version,value=EXCLUDED.value",
          [claim.id, check.source, claim.pickVersion, JSON.stringify(check)],
        );
      for (const item of check.items) {
        const { retrievedAt, ...content } = item;
        await c.query(
          "INSERT INTO independent_evidence(id,platform,native_id,source,item,retrieved_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
          [
            hash([m.platform, m.nativeId, check.source, content]),
            m.platform,
            m.nativeId,
            check.source,
            JSON.stringify(item),
            retrievedAt,
          ],
        );
      }
      await c.query(
        "INSERT INTO independent_source_checks(platform,native_id,source,value,checked_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(platform,native_id,source) DO UPDATE SET value=EXCLUDED.value,checked_at=EXCLUDED.checked_at",
        [
          m.platform,
          m.nativeId,
          check.source,
          JSON.stringify(check),
          check.checkedAt,
        ],
      );
    }
    await c.query("COMMIT");
    return true;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
