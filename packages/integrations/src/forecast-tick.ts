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
  return runLeasedForecastJob(pool, "nba.capture", () =>
    capture(pool, undefined, { maximumEvents: 3 }),
  );
}
export async function runLeasedForecastJob<T>(
  pool: Pool,
  job: "nba.capture" | "nba.maintenance",
  work: () => Promise<T>,
) {
  const owner = randomUUID();
  const lease = await pool.query(
    `INSERT INTO forecast_worker_health(job,lease_owner,lease_until,last_started_at)
    VALUES($2,$1,clock_timestamp()+interval '150 seconds',clock_timestamp())
    ON CONFLICT(job) DO UPDATE SET lease_owner=EXCLUDED.lease_owner,lease_until=EXCLUDED.lease_until,last_started_at=EXCLUDED.last_started_at
    WHERE forecast_worker_health.lease_until IS NULL OR forecast_worker_health.lease_until<clock_timestamp() RETURNING job`,
    [owner, job],
  );
  if (!lease.rows.length) return { status: "already_running" as const };
  try {
    const result = await work();
    await pool.query(
      `UPDATE forecast_worker_health SET last_success_at=clock_timestamp(),summary=$2,lease_until=NULL,lease_owner=NULL WHERE job=$3 AND lease_owner=$1`,
      [owner, JSON.stringify(result), job],
    );
    return { status: "ok" as const, ...result };
  } catch {
    await pool.query(
      `UPDATE forecast_worker_health SET last_failed_at=clock_timestamp(),summary='{"error":"JOB_FAILED"}'::jsonb,lease_until=NULL,lease_owner=NULL WHERE job=$2 AND lease_owner=$1`,
      [owner, job],
    );
    throw Error("FORECAST_TICK_FAILED");
  }
}
