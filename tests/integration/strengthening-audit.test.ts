import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  auditStrengthening,
  exportForecastCohort,
} from "../../packages/db/src/strengthening-audit";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("read-only strengthening reports", () => {
  const pool = new Pool({ connectionString: url }),
    user = randomUUID(),
    other = randomUUID();
  beforeAll(async () => {
    for (const id of [user, other])
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        id,
      ]);
    for (const [who, namespace] of [
      [user, "live"],
      [user, "replay:test"],
      [other, "live"],
    ] as const)
      await pool.query(
        "INSERT INTO nba_forecasts(id,user_id,namespace,event_id,horizon,method_version,scheduled_at,captured_at,payload,request_hash) VALUES($1,$2,$3,$4,'T24h','test',clock_timestamp()+interval '1 day',clock_timestamp()-interval '1 day',$5,$6)",
        [
          randomUUID(),
          who,
          namespace,
          who + namespace,
          {
            probability: 0.6,
            baselineProbability: 0.5,
            homeTeam: "A",
            awayTeam: "B",
            rationale: "PRIVATE_TEXT",
            modelConfig: { key: "SECRET_CONFIG" },
            evidence: [
              {
                url: "https://nba.com/game?token=SECRET_QUERY",
                retrievedAt: "2026-01-01T00:00:00Z",
                publishedAt: null,
              },
            ],
          },
          "a".repeat(64),
        ],
      );
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1::text[])", [
      [user, other],
    ]);
    await pool.end();
  });
  it("exports only one selected owner/mode cohort with explicit unknown denominators and no raw private content", async () => {
    const report = await exportForecastCohort(pool, {
      user,
      namespace: "live",
      method: "test",
      horizon: "T24h",
    });
    expect(report.samples).toHaveLength(1);
    expect(report.samples[0]!.eventId).toBe(user + "live");
    expect(report.denominators.scheduledEvents).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(
      /PRIVATE_TEXT|SECRET_CONFIG|SECRET_QUERY|replay:test/,
    );
    const replay = await exportForecastCohort(pool, {
      user,
      namespace: "replay:test",
      method: "test",
      horizon: "T24h",
    });
    expect(replay.mode).toBe("historical_replay");
  });
  it("returns only whitelisted flag values and ledger aggregates without mutation", async () => {
    const before = (
      await pool.query(
        "SELECT count(*)::int AS n FROM nba_forecasts WHERE user_id=$1",
        [user],
      )
    ).rows[0].n;
    const audit = await auditStrengthening(pool, user, {
      LLM_API_KEY: "SECRET",
      GRAPH_RETRIEVAL_MODE: "verified",
      PROCEDURE_VERSION: "PRIVATE_VERSION",
    });
    expect(audit.flags.GRAPH_RETRIEVAL_MODE).toBe("verified");
    expect(JSON.stringify(audit)).not.toMatch(
      /PRIVATE_VERSION|SECRET|PRIVATE_TEXT/,
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM nba_forecasts WHERE user_id=$1",
          [user],
        )
      ).rows[0].n,
    ).toBe(before);
    await expect(
      auditStrengthening(pool, "foreign-missing", {}),
    ).rejects.toThrow("OWNER_NOT_FOUND");
  });
});
