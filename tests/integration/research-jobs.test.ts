import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  enqueueResearchJob,
  claimResearchJob,
  finishResearchJob,
  failResearchJob,
  enqueueTypedResearchJob,
  claimTypedResearchJob,
} from "../../packages/db/src/research-jobs";
import {
  runTypedResearchJob,
  pythonResearch,
} from "../../packages/integrations/src/research-jobs";
import { resolve } from "node:path";
import { scheduleResearchCohort } from "../../packages/db/src/research-cohort";
import type { ResearchEnvelope } from "../../packages/domain/src/strengthening-contracts";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "research job ownership, leases and retries",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const owner = randomUUID();
    beforeAll(async () => {
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        owner,
      ]);
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=$1", [owner]);
      await pool.end();
    });
    const payload = (): ResearchEnvelope => ({
      schemaVersion: 1,
      jobId: randomUUID(),
      namespace: "evaluation:test",
      mode: "synthetic",
      ownerId: owner,
      eventId: "event",
      marketId: "market",
      outcomeId: "yes",
      cutoffAt: "2026-10-31T01:00:00Z",
      eventStartAt: "2026-10-31T02:00:00Z",
      evidence: [
        {
          id: "e",
          sha256: "a".repeat(64),
          originId: "origin",
          url: "https://example.com",
          observedAt: "2026-10-31T00:00:00Z",
          availableAt: "2026-10-31T00:00:00Z",
          publishedAt: null,
          eventId: "event",
        },
      ],
      modelVersion: "m1",
      procedureVersion: "p1",
      maxCalls: 3,
      maxOutputTokens: 2000,
    });
    it("runs authorized GEPA action replay through queue, Python and immutable result", async () => {
      const p = payload();
      await enqueueTypedResearchJob(pool, {
        ownerId: owner,
        operationKey: randomUUID(),
        payload: p,
        artifact: {
          operation: "procedure_optimize",
          payload: {
            seed: { proposedReadOrder: '["quote"]' },
            proposals: [{ proposedReadOrder: '["report"]' }],
            requestedBy: owner,
            reviewerId: "independent-evaluation-reviewer",
            optimizerConsent: true,
            mode: "synthetic",
            corpusVersion: "self-authored-synthetic-v1",
            maxCandidates: 2,
            cases: [
              {
                id: "injury",
                split: "development",
                optimizerConsent: true,
                expectedActions: ["report"],
                allowedEvidenceIds: ["official"],
                requiredEvidenceIds: ["official"],
                tools: { quote: [], report: ["official"] },
              },
            ],
          },
        },
        deadlineAt: new Date(Date.now() + 120000).toISOString(),
      });
      const result = await runTypedResearchJob(pool, {
        ownerId: owner,
        enabled: true,
        dailyQuota: 100,
        remainingMs: 60000,
        execute: (request, timeoutMs) =>
          pythonResearch({
            python:
              process.env.RESEARCH_PYTHON ??
              resolve("workers/research/.venv/Scripts/python.exe"),
            cwd: resolve("workers/research"),
            request,
            timeoutMs,
          }),
      });
      expect(result.completed).toBe(1);
      const saved = (
        await pool.query("SELECT state,result FROM research_jobs WHERE id=$1", [
          p.jobId,
        ])
      ).rows[0];
      expect(saved.state).toBe("completed");
      expect(saved.result).toMatchObject({
        method: "gepa.action_replay",
        validationPassed: false,
        sealedTestPassed: false,
        benefitDemonstrated: false,
        usage: { modelCalls: 0 },
        selectedCandidate: { proposedReadOrder: '["report"]' },
      });
      expect(saved.result.raw.length).toBeGreaterThan(0);
      // This new scenario shares the suite owner; do not consume the later
      // concurrency scenario's deliberately one-job test allowance.
      await pool.query("DELETE FROM research_worker_daily_usage WHERE user_id=$1", [owner]);
    }, 60000);
    it("refuses automatic cohorts without current subscription consent", async () => {
      expect(await scheduleResearchCohort(pool, owner)).toMatchObject({
        scheduled: 0,
        reason: "consent_or_subscription_required",
      });
      await pool.query(
        "INSERT INTO nba_forecast_subscriptions(user_id,enabled,memory_consent) VALUES($1,true,true)",
        [owner],
      );
      expect(await scheduleResearchCohort(pool, owner)).toMatchObject({
        scheduled: 0,
        reason: "no_live_forecasts",
      });
      await pool.query(
        "UPDATE nba_forecast_subscriptions SET memory_consent=false WHERE user_id=$1",
        [owner],
      );
      expect(await scheduleResearchCohort(pool, owner)).toMatchObject({
        scheduled: 0,
        reason: "consent_or_subscription_required",
      });
    });
    it("deduplicates enqueue but rejects changed content", async () => {
      const p = payload(),
        op = randomUUID(),
        args = {
          ownerId: owner,
          kind: "forecast",
          operationKey: op,
          payload: p,
        };
      expect(await enqueueResearchJob(pool, args)).toBe(p.jobId);
      expect(await enqueueResearchJob(pool, args)).toBe(p.jobId);
      await expect(
        enqueueResearchJob(pool, { ...args, payload: { ...p, maxCalls: 4 } }),
      ).rejects.toThrow("IDEMPOTENCY");
      await expect(
        enqueueResearchJob(pool, { ...args, ownerId: "foreign" }),
      ).rejects.toThrow("OWNER");
    });
    it("persists typed artifacts atomically, rejects mutation and reserves quota under concurrent claims", async () => {
      const p = payload();
      const args = {
        ownerId: owner,
        operationKey: randomUUID(),
        payload: p,
        artifact: {
          operation: "calibration" as const,
          payload: { probabilities: [0.2], labels: [1 as const], bins: 10 },
        },
        deadlineAt: new Date(Date.now() + 60000).toISOString(),
      };
      await enqueueTypedResearchJob(pool, args);
      await expect(
        enqueueTypedResearchJob(pool, {
          ...args,
          artifact: {
            ...args.artifact,
            payload: { ...args.artifact.payload, probabilities: [0.3] },
          },
        }),
      ).rejects.toThrow("IDEMPOTENCY");
      const claims = await Promise.all([
        claimTypedResearchJob(pool, {
          ownerId: owner,
          dailyQuota: 1,
          leaseSeconds: 30,
        }),
        claimTypedResearchJob(pool, {
          ownerId: owner,
          dailyQuota: 1,
          leaseSeconds: 30,
        }),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean).artifact).toMatchObject({
        operation: "calibration",
      });
      await pool.query(
        "DELETE FROM research_worker_daily_usage WHERE user_id=$1",
        [owner],
      );
      await pool.query("DELETE FROM research_jobs WHERE id=$1", [p.jobId]);
    });
    it("executes the real Python calibration CLI and records immutable result", async () => {
      const p = payload();
      await enqueueTypedResearchJob(pool, {
        ownerId: owner,
        operationKey: randomUUID(),
        payload: p,
        artifact: {
          operation: "calibration",
          payload: { probabilities: [0.2, 0.8], labels: [0, 1], bins: 10 },
        },
        deadlineAt: new Date(Date.now() + 120000).toISOString(),
      });
      const result = await runTypedResearchJob(pool, {
        ownerId: owner,
        enabled: true,
        dailyQuota: 100,
        remainingMs: 60000,
        execute: (request, timeoutMs) =>
          pythonResearch({
            python:
              process.env.RESEARCH_PYTHON ??
              resolve("workers/research/.venv/Scripts/python.exe"),
            cwd: resolve("workers/research"),
            request,
            timeoutMs,
          }),
      });
      expect(result.completed).toBe(1);
      const saved = (
        await pool.query("SELECT state,result FROM research_jobs WHERE id=$1", [
          p.jobId,
        ])
      ).rows[0];
      expect(saved.state).toBe("completed");
      expect(saved.result.method).toBe("netcal.ECE");
      expect(saved.result.brier).toBeCloseTo(0.04);
    }, 60000);
    it("rebuilds River from typed ledger rows and rejects expired inputs before execution", async () => {
      const expired = payload();
      await enqueueTypedResearchJob(pool, {
        ownerId: owner,
        operationKey: randomUUID(),
        payload: expired,
        artifact: {
          operation: "online_learning",
          payload: { rows: [], asOf: "2026-11-01T00:00:00Z" },
        },
        deadlineAt: new Date(Date.now() - 1000).toISOString(),
      });
      const p = payload();
      await enqueueTypedResearchJob(pool, {
        ownerId: owner,
        operationKey: randomUUID(),
        payload: p,
        artifact: {
          operation: "online_learning",
          payload: {
            rows: [
              {
                forecastId: "one",
                eventId: "one",
                outcomeVersion: 1,
                challengerVersion: "v1",
                availableAt: "2026-10-31T04:00:00Z",
                cutoffAt: "2026-10-31T01:00:00Z",
                probability: 0.7,
                label: 1,
                league: "NBA",
                marketType: "winner",
                horizon: "24h",
                primary: true,
              },
            ],
            asOf: "2026-11-01T00:00:00Z",
          },
        },
        deadlineAt: new Date(Date.now() + 120000).toISOString(),
      });
      const result = await runTypedResearchJob(pool, {
        ownerId: owner,
        enabled: true,
        dailyQuota: 100,
        remainingMs: 60000,
        execute: (request, timeoutMs) =>
          pythonResearch({
            python:
              process.env.RESEARCH_PYTHON ??
              resolve("workers/research/.venv/Scripts/python.exe"),
            cwd: resolve("workers/research"),
            request,
            timeoutMs,
          }),
      });
      expect(result.completed).toBe(1);
      const rows = (
        await pool.query(
          "SELECT id,state,result,error_code FROM research_jobs WHERE id=ANY($1)",
          [[p.jobId, expired.jobId]],
        )
      ).rows;
      expect(rows.find((r) => r.id === expired.jobId)).toMatchObject({
        state: "failed",
        error_code: "DEADLINE_EXCEEDED",
      });
      expect(rows.find((r) => r.id === p.jobId).result).toMatchObject({
        method: "river.predict_then_learn.ADWIN",
        samples: 1,
        automaticAuthority: false,
      });
    }, 60000);
    it("allows one concurrent claimant and blocks foreign or stale completion", async () => {
      const p = payload();
      await enqueueResearchJob(pool, {
        ownerId: owner,
        kind: "lease",
        operationKey: randomUUID(),
        payload: p,
      });
      const args = { ownerId: owner, kind: "lease", leaseSeconds: 30 };
      const results = await Promise.all([
        claimResearchJob(pool, args),
        claimResearchJob(pool, args),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const job = results.find(Boolean)!;
      const finish = {
        id: job.id,
        ownerId: owner,
        token: job.lease_token,
        result: { status: "ok" },
      };
      await expect(
        finishResearchJob(pool, { ...finish, ownerId: "foreign" }),
      ).rejects.toThrow();
      await finishResearchJob(pool, finish);
      await finishResearchJob(pool, finish);
      await expect(
        finishResearchJob(pool, { ...finish, result: { status: "different" } }),
      ).rejects.toThrow();
    });
    it("reclaims expiry and fails terminally after third attempt", async () => {
      const p = payload();
      await enqueueResearchJob(pool, {
        ownerId: owner,
        kind: "retry",
        operationKey: randomUUID(),
        payload: p,
      });
      const args = { ownerId: owner, kind: "retry", leaseSeconds: 30 };
      const first = await claimResearchJob(pool, args);
      await pool.query(
        "UPDATE research_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [p.jobId],
      );
      const second = await claimResearchJob(pool, args);
      expect(second.attempts).toBe(2);
      await expect(
        finishResearchJob(pool, {
          id: p.jobId,
          ownerId: owner,
          token: first.lease_token,
          result: {},
        }),
      ).rejects.toThrow();
      await failResearchJob(pool, {
        id: p.jobId,
        ownerId: owner,
        token: second.lease_token,
        code: "TIMEOUT",
      });
      expect(await claimResearchJob(pool, args)).toBeNull();
      await pool.query(
        "UPDATE research_jobs SET retry_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [p.jobId],
      );
      const third = await claimResearchJob(pool, args);
      await failResearchJob(pool, {
        id: p.jobId,
        ownerId: owner,
        token: third.lease_token,
        code: "TIMEOUT",
      });
      expect(await claimResearchJob(pool, args)).toBeNull();
      expect(
        (
          await pool.query("SELECT state FROM research_jobs WHERE id=$1", [
            p.jobId,
          ])
        ).rows[0].state,
      ).toBe("failed");
    });
  },
);
