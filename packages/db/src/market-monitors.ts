import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  monitorCreateSchema,
  marketObservationSchema,
  compareMarketObservation,
  type MarketObservation,
} from "../../domain/src/market-monitor";
import { DomainConflict } from "../../domain/src/index";
import { gradeForecast } from "../../domain/src/forecast";
import { decideResearchReadiness } from "../../domain/src/decision-quality";
import { storedEventStart } from "./forecast-lock";
import {
  newsCheckSchema,
  type NewsCheck,
} from "../../integrations/src/news/collect";
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export async function createMonitor(
  pool: Pool,
  userId: string,
  value: unknown,
) {
  const input = monitorCreateSchema.parse(value),
    c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify(["monitor-account", userId]),
    ]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([userId, input.requestId]),
    ]);
    const hash = digest({ kind: "market.monitor", ...input });
    const old = (
      await c.query(
        "SELECT request_hash,result FROM mutation_requests WHERE user_id=$1 AND request_id=$2",
        [userId, input.requestId],
      )
    ).rows[0];
    if (old) {
      if (old.request_hash !== hash)
        throw new DomainConflict("IDEMPOTENCY_KEY_REUSED");
      await c.query("COMMIT");
      return old.result;
    }
    const pick = (
      await c.query(
        "SELECT p.*,v.snapshot_id FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE OF p",
        [input.pickId, userId],
      )
    ).rows[0];
    if (!pick) throw new Error("NOT_FOUND");
    if (pick.current_version !== input.baseVersion)
      throw new DomainConflict("VERSION_CONFLICT");
    const raw = (
      await c.query("SELECT raw FROM market_snapshots WHERE id=$1", [
        pick.snapshot_id,
      ])
    ).rows[0]?.raw;
    const provider = raw?.catalogProvider === "tatum" ? "tatum" : "public";
    const count = (
      await c.query(
        "SELECT count(*)::int n FROM market_monitors WHERE user_id=$1 AND state='active'",
        [userId],
      )
    ).rows[0].n;
    const existing = (
      await c.query(
        "SELECT id,state FROM market_monitors WHERE user_id=$1 AND pick_id=$2",
        [userId, pick.id],
      )
    ).rows[0];
    if (count >= 20 && existing?.state !== "active")
      throw new DomainConflict("MONITOR_LIMIT_REACHED");
    const result = (
      await c.query(
        "INSERT INTO market_monitors(id,user_id,pick_id,pick_version,platform,native_id,provider,deadline,independent_news) VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8*interval '1 hour'),$9) ON CONFLICT(user_id,pick_id) DO UPDATE SET state='active',pick_version=EXCLUDED.pick_version,provider=EXCLUDED.provider,deadline=EXCLUDED.deadline,independent_news=EXCLUDED.independent_news,observation=NULL,source_health='pending',lease_until=NULL,next_check_at=now(),attempts=market_monitors.attempts+1 RETURNING id,deadline",
        [
          randomUUID(),
          userId,
          pick.id,
          input.baseVersion,
          pick.platform,
          pick.native_id,
          provider,
          input.durationHours,
          input.independentNews,
        ],
      )
    ).rows[0];
    result.deadline = new Date(result.deadline).toISOString();
    await c.query(
      "DELETE FROM independent_watch_baselines WHERE monitor_id=$1",
      [result.id],
    );
    await c.query(
      "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
      [userId, input.requestId, hash, JSON.stringify(result)],
    );
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function monitorInbox(pool: Pool, userId: string) {
  const monitors = (
    await pool.query(
      "SELECT m.*,s.question,d.decision AS latest_decision FROM market_monitors m JOIN picks p ON p.id=m.pick_id AND p.user_id=m.user_id JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version LEFT JOIN market_snapshots s ON s.id=v.snapshot_id LEFT JOIN LATERAL (SELECT decision FROM decision_traces WHERE user_id=m.user_id AND pick_id=m.pick_id AND pick_version=m.pick_version AND decision->>'monitorId'=m.id AND model_version='deterministic:coverage-v1' ORDER BY created_at DESC LIMIT 1) d ON true WHERE m.user_id=$1 ORDER BY m.created_at DESC LIMIT 100",
      [userId],
    )
  ).rows;
  const updates = (
    await pool.query(
      "SELECT u.id,u.kind,u.evidence,u.read_at,u.created_at,m.platform,m.native_id,m.pick_id FROM market_updates u JOIN market_monitors m ON m.id=u.monitor_id AND m.user_id=u.user_id WHERE u.user_id=$1 ORDER BY u.created_at DESC LIMIT 100",
      [userId],
    )
  ).rows;
  return { monitors, updates };
}
export async function controlMonitor(
  pool: Pool,
  userId: string,
  id: string,
  action: "paused" | "read",
) {
  const result =
    action === "paused"
      ? await pool.query(
          "UPDATE market_monitors SET state='paused',lease_until=NULL,attempts=attempts+1 WHERE id=$1 AND user_id=$2 RETURNING id",
          [id, userId],
        )
      : await pool.query(
          "UPDATE market_updates SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id",
          [id, userId],
        );
  if (!result.rows.length) throw new Error("NOT_FOUND");
  return { id };
}
export type MonitorClaim = {
  id: string;
  userId: string;
  pickId: string;
  pickVersion: number;
  platform: "kalshi" | "polymarket";
  nativeId: string;
  provider: "public" | "tatum";
  attempt: number;
  independentNews: boolean;
  observation: MarketObservation | null;
};
export async function claimMonitor(pool: Pool): Promise<MonitorClaim | null> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "UPDATE market_monitors SET state='expired',lease_until=NULL WHERE state='active' AND deadline<=now()",
    );
    await c.query(
      "UPDATE market_monitors m SET state='superseded',lease_until=NULL FROM picks p WHERE p.id=m.pick_id AND p.user_id=m.user_id AND p.current_version<>m.pick_version AND m.state='active'",
    );
    const row = (
      await c.query(
        "SELECT * FROM market_monitors WHERE state='active' AND deadline>now() AND next_check_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY next_check_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!row) {
      await c.query("COMMIT");
      return null;
    }
    await c.query(
      "UPDATE market_monitors SET attempts=attempts+1,lease_until=now()+interval '60 seconds' WHERE id=$1",
      [row.id],
    );
    await c.query("COMMIT");
    return {
      id: row.id,
      userId: row.user_id,
      pickId: row.pick_id,
      pickVersion: row.pick_version,
      platform: row.platform,
      nativeId: row.native_id,
      provider: row.provider,
      attempt: row.attempts + 1,
      independentNews: row.independent_news === true,
      observation: row.observation
        ? marketObservationSchema.parse(row.observation)
        : null,
    };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function finishMonitor(
  pool: Pool,
  claim: MonitorClaim,
  next: MarketObservation | null,
  independentChecks: NewsCheck[] = [],
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const row = (
      await c.query(
        "SELECT m.id,m.source_health,v.outcome,v.created_at AS pick_created_at,s.raw,clock_timestamp() AS checked_at FROM market_monitors m JOIN picks p ON p.id=m.pick_id AND p.user_id=m.user_id AND p.current_version=m.pick_version JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=m.pick_version LEFT JOIN market_snapshots s ON s.id=v.snapshot_id WHERE m.id=$1 AND m.user_id=$2 AND m.state='active' AND m.attempts=$3 AND m.lease_until>now() AND m.deadline>now() FOR UPDATE OF p,m",
        [claim.id, claim.userId, claim.attempt],
      )
    ).rows[0];
    if (!row) {
      await c.query("ROLLBACK");
      return false;
    }
    if (next) marketObservationSchema.parse(next);
    const change = next
      ? claim.observation
        ? compareMarketObservation(claim.observation, next)
        : {
            ...compareMarketObservation(next, next),
            kind:
              compareMarketObservation(next, next).kind === "unchanged"
                ? next.resolution
                  ? "market_resolved"
                  : "baseline"
                : compareMarketObservation(next, next).kind,
          }
      : { kind: "source_delayed", reasonChanged: false };
    const health = next
      ? ["source_incomplete", "source_delayed"].includes(change.kind)
        ? change.kind
        : "available"
      : "source_delayed";
    const shouldNotify =
      [
        "rules_changed",
        "price_changed",
        "market_resolved",
        "resolution_corrected",
      ].includes(change.kind) ||
      (["source_incomplete", "source_delayed"].includes(change.kind) &&
        row.source_health !== health);
    const checks = independentChecks
      .slice(0, 10)
      .map((v) => newsCheckSchema.parse(v));
    // Optional providers without credentials and unrelated background feeds are
    // not required checks. A mapped required source that failed still blocks.
    const requiredChecks = checks.filter(
      (check) =>
        !check.background &&
        !["unconfigured", "unmapped"].includes(check.state),
    );
    const decision = decideResearchReadiness(
      [
        {
          id: "market",
          status: health === "available" ? "observed" : "unavailable",
          asOf: next?.fetchedAt ?? null,
          changed: [
            "rules_changed",
            "price_changed",
            "market_resolved",
            "resolution_corrected",
          ].includes(change.kind),
        },
        ...(claim.independentNews
          ? requiredChecks.length
            ? requiredChecks.map((check) => ({
                id: check.source,
                status:
                  check.state === "available"
                    ? ("observed" as const)
                    : ("unavailable" as const),
                asOf: check.checkedAt,
                changed: false,
              }))
            : [
                {
                  id: "independent_sources",
                  status: "unavailable" as const,
                  asOf: null,
                  changed: false,
                },
              ]
          : []),
      ],
      new Date(row.checked_at).toISOString(),
    );
    // Record quiet checks as well as alerts. The lease fence makes retry writes unique.
    await c.query(
      "INSERT INTO decision_traces(id,user_id,pick_id,pick_version,observation_ids,lesson_versions,decision,citations,model_version) VALUES($1,$2,$3,$4,$5,'[]',$6,$7,'deterministic:coverage-v1')",
      [
        digest(["monitor-decision", claim.id, claim.attempt]),
        claim.userId,
        claim.pickId,
        claim.pickVersion,
        JSON.stringify([digest(next), ...checks.map((check) => digest(check))]),
        JSON.stringify({
          ...decision,
          monitorId: claim.id,
          attempt: claim.attempt,
          marketChange: change.kind,
          independentChangesAssessed: false,
        }),
        JSON.stringify(next ? [next.sourceUrl] : []),
      ],
    );
    if (shouldNotify) {
      const key = digest([
        claim.id,
        claim.pickVersion,
        change.kind,
        next
          ? {
              rules: next.rules,
              prices: next.prices,
              resolution: next.resolution ?? null,
            }
          : null,
      ]);
      await c.query(
        "INSERT INTO market_updates(id,monitor_id,user_id,dedupe_key,kind,evidence) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING",
        [
          randomUUID(),
          claim.id,
          claim.userId,
          key,
          change.kind,
          JSON.stringify({
            previous: claim.observation,
            current: next,
            reasonChanged: false,
            assessment: next?.resolution
              ? {
                  pickVersion: claim.pickVersion,
                  pickedOutcome: row.outcome,
                  result: gradeForecast({
                    eventId: `${claim.platform}:${claim.nativeId}`,
                    recordedAt: new Date(row.pick_created_at).toISOString(),
                    scheduledAt: storedEventStart(row.raw),
                    resolvedAt: next.resolution.resolvedAt,
                    outcome: row.outcome,
                    winner: next.resolution.outcome,
                    status:
                      Date.parse(next.resolution.resolvedAt) <=
                      new Date(row.checked_at).getTime()
                        ? "final"
                        : "pending",
                    probability: null,
                    baselineProbability: null,
                  }).comparison,
                }
              : null,
            note: "Market source observation only. No independent news or automatic change to your view.",
          }),
        ],
      );
    }
    await c.query(
      "UPDATE market_monitors SET observation=COALESCE($4,observation),source_health=$5,lease_until=NULL,next_check_at=now()+interval '5 minutes' WHERE id=$1 AND user_id=$2 AND attempts=$3",
      [
        claim.id,
        claim.userId,
        claim.attempt,
        next && !["source_delayed", "source_incomplete"].includes(change.kind)
          ? JSON.stringify(next)
          : null,
        health,
      ],
    );
    await c.query("COMMIT");
    return true;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
