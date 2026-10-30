import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { captureDueForecasts } from "./forecast-scheduler";

export function authorizeForecastTick(
  header: string | null,
  secret: string | undefined,
) {
  if (!secret || secret.length < 32 || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`),
    actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A database-clock lease fences overlapping cloud/GitHub invocations and expires after crashes. */
export async function runForecastTick(
  pool: Pool,
  capture = captureDueForecasts,
) {
  const owner = randomUUID();
  const lease = await pool.query(
    `INSERT INTO forecast_worker_health(job,lease_owner,lease_until,last_started_at)
    VALUES('nba.capture',$1,clock_timestamp()+interval '150 seconds',clock_timestamp())
    ON CONFLICT(job) DO UPDATE SET lease_owner=EXCLUDED.lease_owner,lease_until=EXCLUDED.lease_until,last_started_at=EXCLUDED.last_started_at
    WHERE forecast_worker_health.lease_until IS NULL OR forecast_worker_health.lease_until<clock_timestamp() RETURNING job`,
    [owner],
  );
  if (!lease.rows.length) return { status: "already_running" as const };
  try {
    const result = await capture(pool, undefined, { maximumEvents: 3 });
    await pool.query(
      `UPDATE forecast_worker_health SET last_success_at=clock_timestamp(),summary=$2,lease_until=NULL,lease_owner=NULL WHERE job='nba.capture' AND lease_owner=$1`,
      [owner, JSON.stringify(result)],
    );
    return { status: "ok" as const, ...result };
  } catch {
    await pool.query(
      `UPDATE forecast_worker_health SET last_failed_at=clock_timestamp(),summary='{"error":"CAPTURE_FAILED"}'::jsonb,lease_until=NULL,lease_owner=NULL WHERE job='nba.capture' AND lease_owner=$1`,
      [owner],
    );
    throw Error("FORECAST_TICK_FAILED");
  }
}
