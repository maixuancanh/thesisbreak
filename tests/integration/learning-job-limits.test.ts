import {
  nextMaintenancePhase,
  MAINTENANCE_PHASES,
} from "../../packages/integrations/src/forecast-maintenance";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { runOneLearningJob } from "../../packages/integrations/src/learning-worker";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { claimLearningJob } from "../../packages/db/src/learning-jobs";
import {
  learningBudgetProvider,
  reserveLearningExtraction,
} from "../../packages/db/src/learning-budget";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "fair learning scheduling and bounded model attempt budgets",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      a = randomUUID(),
      b = randomUUID(),
      kind1 = "test:" + randomUUID(),
      kind2 = "test:" + randomUUID();
    beforeAll(async () => {
      for (const id of [a, b])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[a, b]]);
      await pool.query(
        "DELETE FROM provider_credit_budgets WHERE provider=ANY($1)",
        [[learningBudgetProvider(a), learningBudgetProvider(b)]],
      );
      await pool.end();
    });
    it("serves the other owner and unserved kind before an oldest-owner backlog", async () => {
      for (const [owner, kind, age] of [
        [a, kind1, 10],
        [a, kind1, 9],
        [a, kind2, 8],
        [b, kind1, 1],
      ] as const)
        await pool.query(
          "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload,recorded_at) VALUES($1,$2,$3,$1,'{}',clock_timestamp()-$4*interval '1 minute')",
          [randomUUID(), owner, kind, age],
        );
      const next = async () => {
        const r = await claimLearningJob(pool, {
          kinds: [kind1, kind2],
          token: randomUUID(),
          leaseSeconds: 30,
        });
        await pool.query(
          "UPDATE learning_jobs SET state='completed' WHERE id=$1",
          [r.id],
        );
        return r;
      };
      expect((await next()).user_id).toBe(a);
      expect((await next()).user_id).toBe(b);
      const third = await next();
      expect(third.user_id).toBe(a);
      expect(third.kind).toBe(kind2);
    });
    it("reserves owner and service attempts atomically, records bounds separately and rejects excessive input", async () => {
      const id = randomUUID(),
        token = randomUUID();
      await pool.query(
        "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload,state,lease_token,lease_until) VALUES($1,$2,'extract',$1,'{}','processing',$3,clock_timestamp()+interval '1 minute')",
        [id, a, token],
      );
      const input = {
        ownerId: a,
        jobId: id,
        leaseToken: token,
        inputBytes: 2000,
        maxInputBytes: 64000,
        maxOutputTokens: 3500,
        ownerDailyAttempts: 1,
        globalDailyAttempts: 10000,
      };
      const used = async () =>
        Number(
          (
            await pool.query(
              "SELECT credits FROM provider_credit_budgets WHERE provider=$1 AND budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date",
              [learningBudgetProvider()],
            )
          ).rows[0]?.credits ?? 0,
        );
      const before = await used();
      await reserveLearningExtraction(pool, input);
      await expect(reserveLearningExtraction(pool, input)).rejects.toThrow(
        "EXTRACTION_BUDGET_DEFERRED",
      );
      expect(await used()).toBe(before + 1);
      const payload = (
        await pool.query("SELECT payload FROM learning_jobs WHERE id=$1", [id])
      ).rows[0].payload;
      expect(payload.budgetAttempts).toHaveLength(1);
      expect(payload.budgetAttempts[0]).toMatchObject({
        unit: "bounded_model_attempt",
        reservedAttempts: 1,
        inputBytes: 2000,
        maxOutputTokens: 3500,
      });
      expect(payload.generationTrace).toBeUndefined();
      await expect(
        reserveLearningExtraction(pool, { ...input, inputBytes: 64001 }),
      ).rejects.toThrow("EXTRACTION_INPUT_LIMIT");
    });
    it("defers exhausted workers without another model call and fails oversized prompts explicitly", async () => {
      let calls = 0;
      const generate = async () => {
        calls++;
        return { candidates: [] };
      };
      const complete = async () => {
        const r = await claimRun(pool, b, {
          platform: "polymarket",
          nativeId: "123456",
          provider: "public",
          message: "Check official sources before reconsidering.",
          requestId: randomUUID(),
        });
        await pool.query(
          "UPDATE conversations SET memory_consent=true WHERE user_id=$1 AND id=$2",
          [b, r.conversationId],
        );
        await finishRun(
          pool,
          b,
          r.id,
          {
            reply: {},
            modelVersion: "fixture",
            learningTrigger: "explicit_correction",
          },
          "completed",
        );
        return r;
      };
      const env = {
        LEARNING_OWNER_DAILY_ATTEMPTS: "1",
        LEARNING_DAILY_ATTEMPTS: "10000",
      };
      await complete();
      await runOneLearningJob(pool, env, generate, b);
      expect(await runOneLearningJob(pool, env, generate, b)).toEqual({
        checked: 1,
        completed: 1,
      });
      await complete();
      await runOneLearningJob(pool, env, generate, b);
      expect(await runOneLearningJob(pool, env, generate, b)).toEqual({
        checked: 1,
        completed: 0,
      });
      expect(calls).toBe(1);
      const deferred = (
        await pool.query(
          "SELECT state,attempts,last_error,retry_at,clock_timestamp() AS checked_at,(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' AS expected_retry_at FROM learning_jobs WHERE user_id=$1 AND kind='extract' AND state='retry'",
          [b],
        )
      ).rows[0];
      expect(deferred).toMatchObject({
        state: "retry",
        attempts: 0,
        last_error: "EXTRACTION_BUDGET_DEFERRED",
      });
      expect(new Date(deferred.retry_at).getTime()).toBeGreaterThan(
        new Date(deferred.checked_at).getTime(),
      );
      expect(new Date(deferred.retry_at).toISOString()).toBe(
        new Date(deferred.expected_retry_at).toISOString(),
      );
      await complete();
      await runOneLearningJob(pool, env, generate, b);
      expect(
        await runOneLearningJob(
          pool,
          { ...env, LEARNING_MAX_INPUT_BYTES: "1" },
          generate,
          b,
        ),
      ).toEqual({ checked: 1, completed: 0 });
      expect(calls).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT last_error FROM learning_jobs WHERE user_id=$1 AND state='failed'",
            [b],
          )
        ).rows[0].last_error,
      ).toBe("EXTRACTION_INPUT_LIMIT");
    });
    it("persists the maintenance remote rotation independently of wall clock and failure summaries", async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "DELETE FROM forecast_worker_health WHERE job='nba.maintenance.rotation'",
        );
        const observed = [];
        for (let i = 0; i < 2 * MAINTENANCE_PHASES.length; i++)
          observed.push(await nextMaintenancePhase(c));
        expect(observed).toHaveLength(14);
        expect(observed).toEqual([
          ...MAINTENANCE_PHASES,
          ...MAINTENANCE_PHASES,
        ]);
        const row = (
          await c.query(
            "SELECT summary FROM forecast_worker_health WHERE job='nba.maintenance.rotation'",
          )
        ).rows[0];
        expect(row.summary).toEqual({ next: 0 });
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });
  },
);
