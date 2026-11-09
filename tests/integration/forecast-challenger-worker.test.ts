import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureNbaForecast } from "../../packages/db/src/forecast-ledger";
import { persistNbaObservation } from "../../packages/integrations/src/forecast-observations";
import {
  claimAutomaticChallenger,
  runAutomaticForecastChallenger,
} from "../../packages/integrations/src/forecast-challenger-worker";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("automatic challenger reservation and completion", () => {
  const pool = new Pool({ connectionString: url }),
    owner = randomUUID();
  const model = `test-${randomUUID()}`;
  const env = {
    FORECAST_CHALLENGER_ENABLED: "true",
    FORECAST_CHALLENGER_MODE: "shadow",
    LLM_MODEL: model,
    LLM_API_KEY: "test-only",
    LLM_BASE_URL: "https://example.invalid/v1",
    FORECAST_CHALLENGER_OWNER_DAILY_CALLS: "6",
    FORECAST_CHALLENGER_SERVICE_DAILY_CALLS: "300",
  };
  const forecasts: string[] = [];
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
      owner,
    ]);
    await pool.query(
      "INSERT INTO nba_forecast_subscriptions(user_id,enabled,memory_consent,challenger_consent) VALUES($1,true,false,false)",
      [owner],
    );
  });
  afterAll(async () => {
    await pool.query("DELETE FROM nba_challenger_jobs WHERE user_id=$1", [
      owner,
    ]);
    await pool.query("DELETE FROM nba_challenger_daily_usage WHERE scope=$1", [
      `owner:${owner}`,
    ]);
    await pool.query("DELETE FROM users WHERE id=$1", [owner]);
    await pool.end();
  });
  async function capture() {
    const now = new Date(
      (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now,
    );
    const source = `https://site.api.espn.com/test/${randomUUID()}`;
    const retrievedAt = new Date(now.getTime() - 1000).toISOString();
    await persistNbaObservation(pool, source, retrievedAt, {
      events: [{ id: "game", status: "pending" }],
    });
    const f = await captureNbaForecast(pool, owner, {
      namespace: "live",
      eventId: randomUUID(),
      league: "NBA",
      horizon: "T60m",
      methodVersion: "nba-elo-prospective-v2",
      modelVersion: "elo",
      modelConfig: {},
      scheduledAt: new Date(now.getTime() + 3600000).toISOString(),
      homeTeam: "BOS",
      awayTeam: "BKN",
      probability: 0.6,
      baselineProbability: null,
      abstentionReason: null,
      evidence: [{ url: source, retrievedAt, publishedAt: null }],
      memoryConsent: false,
    });
    forecasts.push(f.id);
    return f.id;
  }
  it("requires explicit opt-in before reserving or invoking anything", async () => {
    await capture();
    expect(await claimAutomaticChallenger(pool, model, 6, 300)).toBeNull();
    expect(
      (
        await pool.query("SELECT * FROM nba_challenger_jobs WHERE user_id=$1", [
          owner,
        ])
      ).rowCount,
    ).toBe(0);
    await pool.query(
      "UPDATE nba_forecast_subscriptions SET challenger_consent=true WHERE user_id=$1",
      [owner],
    );
  });
  it("reserves before calls, persists shadow independently, and never retries completed jobs", async () => {
    let calls = 0;
    const result = await runAutomaticForecastChallenger(
      pool,
      env,
      async (call) => {
        calls++;
        const usage = (
          await pool.query(
            "SELECT calls,tokens FROM nba_challenger_daily_usage WHERE scope=$1",
            [`owner:${owner}`],
          )
        ).rows[0];
        expect(usage).toMatchObject({ calls: 3, tokens: 3000 });
        return {
          componentId: call.role,
          status: "ok",
          probability: 0.55,
          evidenceIds: [call.evidence[0]!.id],
          originIds: ["site.api.espn.com"],
          assumptions: [],
          failureCode: null,
        };
      },
    );
    expect(result.status).toBe("shadow_completed");
    expect(calls).toBe(3);
    const job = (
      await pool.query("SELECT * FROM nba_challenger_jobs WHERE user_id=$1", [
        owner,
      ])
    ).rows[0];
    expect(job.state).toBe("completed");
    expect(job.completed_at.getTime()).toBeLessThan(
      Date.parse(job.envelope.eventStartAt),
    );
    expect(job.result.namespace).toBe("forecast-shadow:live");
    expect(
      (
        await pool.query(
          "SELECT payload->>'probability' AS p FROM nba_forecasts WHERE id=$1",
          [forecasts[0]],
        )
      ).rows[0].p,
    ).toBe("0.6");
    expect(await claimAutomaticChallenger(pool, model, 6, 300)).toBeNull();
    await expect(
      pool.query("UPDATE nba_challenger_jobs SET result='{}' WHERE id=$1", [
        job.id,
      ]),
    ).rejects.toThrow("IMMUTABLE_CHALLENGER_JOB");
  });
  it("serializes concurrent claims, reserves only once, and enforces owner+service ceilings", async () => {
    await capture();
    await capture();
    const claimed = await Promise.all([
      claimAutomaticChallenger(pool, model, 6, 300),
      claimAutomaticChallenger(pool, model, 6, 300),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT calls FROM nba_challenger_daily_usage WHERE scope=$1",
          [`owner:${owner}`],
        )
      ).rows[0].calls,
    ).toBe(6);
    expect(await claimAutomaticChallenger(pool, model, 30, 3)).toBeNull();
  });
  it("honors revocation between calls and rejects completion without consent", async () => {
    let calls = 0;
    const result = await runAutomaticForecastChallenger(
      pool,
      { ...env, FORECAST_CHALLENGER_OWNER_DAILY_CALLS: "30" },
      async (call) => {
        calls++;
        await pool.query(
          "UPDATE nba_forecast_subscriptions SET challenger_consent=false WHERE user_id=$1",
          [owner],
        );
        return {
          componentId: call.role,
          status: "abstained",
          probability: null,
          evidenceIds: [],
          originIds: [],
          assumptions: [],
          failureCode: null,
        };
      },
    );
    expect(result.status).toBe("failed");
    expect(calls).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM nba_challenger_jobs WHERE user_id=$1 AND state='failed'",
          [owner],
        )
      ).rows[0].n,
    ).toBe(1);
    await pool.query(
      "UPDATE nba_forecast_subscriptions SET challenger_consent=true WHERE user_id=$1",
      [owner],
    );
    // Completed/failed jobs and a still leased processing job are never reclaimed.
    expect(await claimAutomaticChallenger(pool, model, 30, 300)).toBeNull();
  });
  it("marks missing retained evidence unavailable without reserving more model calls", async () => {
    const id = await capture();
    await pool.query(
      "DELETE FROM nba_public_snapshots WHERE source_url=(SELECT payload->'evidence'->0->>'url' FROM nba_forecasts WHERE id=$1)",
      [id],
    );
    const before = (
      await pool.query(
        "SELECT calls FROM nba_challenger_daily_usage WHERE scope=$1",
        [`owner:${owner}`],
      )
    ).rows[0].calls;
    expect(await claimAutomaticChallenger(pool, model, 30, 300)).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT state FROM nba_challenger_jobs WHERE forecast_id=$1",
          [id],
        )
      ).rows[0].state,
    ).toBe("unavailable");
    expect(
      (
        await pool.query(
          "SELECT calls FROM nba_challenger_daily_usage WHERE scope=$1",
          [`owner:${owner}`],
        )
      ).rows[0].calls,
    ).toBe(before);
  });
  it("enforces actual pre-event completion in the database itself", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO nba_forecasts(id,user_id,namespace,event_id,horizon,method_version,scheduled_at,captured_at,payload,request_hash) VALUES($1,$2,'live',$1,'T60m','clock-test',clock_timestamp()+interval '0.1 seconds',clock_timestamp(),'{}','fixture')`,
      [id, owner],
    );
    await pool.query(
      "INSERT INTO nba_challenger_jobs(id,forecast_id,user_id,model_version,procedure_version) VALUES($1,$1,$2,$3,'fixture')",
      [id, owner, model],
    );
    await pool.query("SELECT pg_sleep(0.15)");
    await expect(
      pool.query(
        "UPDATE nba_challenger_jobs SET state='completed',result='{}' WHERE id=$1",
        [id],
      ),
    ).rejects.toThrow("CHALLENGER_COMPLETED_LATE");
  });
});
