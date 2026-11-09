import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  runForecastTick,
  runLeasedForecastJob,
} from "../../packages/integrations/src/forecast-tick";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("forecast job lease", () => {
  const pool = new Pool({ connectionString: url });
  beforeEach(async () => {
    await pool.query(
      "DELETE FROM forecast_worker_health WHERE job='nba.capture'",
    );
  });
  afterAll(async () => {
    await pool.query(
      "DELETE FROM forecast_worker_health WHERE job='nba.maintenance'",
    );
    await pool.query(
      "DELETE FROM forecast_worker_health WHERE job='nba.capture'",
    );
    await pool.end();
  });
  it("maintenance has its own lease and cannot block capture", async () => {
    await pool.query(
      "INSERT INTO forecast_worker_health(job,lease_owner,lease_until) VALUES('nba.capture','busy',clock_timestamp()+interval '1 minute')",
    );
    expect(
      await runLeasedForecastJob(pool, "nba.maintenance", async () => ({
        checked: 0,
      })),
    ).toMatchObject({ status: "ok", checked: 0 });
  });
  it("prevents duplicate capture while a tick is in flight and records success", async () => {
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const reachedCapture = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const first = runForecastTick(pool, async () => {
      reached();
      await started;
      return { subscribers: 1, captured: 0, waiting: 0 };
    });
    await reachedCapture;
    expect(
      await runForecastTick(pool, async () => {
        throw Error("SHOULD_NOT_RUN");
      }),
    ).toEqual({ status: "already_running" });
    release();
    await first;
    const row = (
      await pool.query(
        "SELECT * FROM forecast_worker_health WHERE job='nba.capture'",
      )
    ).rows[0];
    expect(row.last_success_at).toBeInstanceOf(Date);
    expect(row.lease_owner).toBeNull();
  });
  it("recovers an expired lease and preserves sanitized failure state", async () => {
    await pool.query(
      "INSERT INTO forecast_worker_health(job,lease_owner,lease_until) VALUES('nba.capture','crashed',clock_timestamp()-interval '1 second')",
    );
    await expect(
      runForecastTick(pool, async () => {
        throw Error("private-provider-detail");
      }),
    ).rejects.toThrow("FORECAST_TICK_FAILED");
    const row = (
      await pool.query(
        "SELECT * FROM forecast_worker_health WHERE job='nba.capture'",
      )
    ).rows[0];
    expect(row.summary).toEqual({ error: "JOB_FAILED" });
    expect(row.last_failed_at).toBeInstanceOf(Date);
    expect(row.lease_until).toBeNull();
  });
});
