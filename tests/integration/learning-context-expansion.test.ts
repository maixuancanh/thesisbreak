import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { runOneLearningJob } from "../../packages/integrations/src/learning-worker";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "authorized extraction original expansion",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID();
    beforeAll(async () => {
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        owner,
      ]);
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=$1", [owner]);
      await pool.end();
    });
    const env = { LEARNING_DAILY_ATTEMPTS: "10000" };
    async function complete(
      message: string,
      eventId: string,
      sessionId?: string,
    ) {
      const run = await claimRun(pool, owner, {
        platform: "polymarket",
        nativeId: eventId,
        provider: "public",
        message,
        requestId: randomUUID(),
        ...(sessionId ? { sessionId } : {}),
      });
      await pool.query(
        "UPDATE conversations SET memory_consent=true WHERE user_id=$1 AND id=$2",
        [owner, run.conversationId],
      );
      await finishRun(
        pool,
        owner,
        run.id,
        {
          reply: {},
          modelVersion: "fixture",
          learningEventId: eventId,
          learningTrigger: "explicit_correction",
        },
        "completed",
      );
      return run;
    }
    it("looks up exact preceding authorized event originals once, excludes secrets/other events and retains both attempts", async () => {
      const previous = await complete(
        "Do not change until the official lineup is published.",
        "111",
      );
      const unsafe = await complete(
        "password=supersecret123456",
        "111",
        previous.conversationId,
      );
      const otherEvent = await complete(
        "Other event requires different evidence.",
        "222",
        previous.conversationId,
      );
      await pool.query(
        "UPDATE learning_jobs SET state='completed' WHERE user_id=$1 AND kind='capture' AND payload->>'runId'=ANY($2)",
        [owner, [previous.id, unsafe.id, otherEvent.id]],
      );
      const current = await complete(
        "Correction: the earlier condition still applies.",
        "111",
        previous.conversationId,
      );
      await runOneLearningJob(
        pool,
        env,
        async () => ({ candidates: [] }),
        owner,
      );
      let calls = 0;
      expect(
        await runOneLearningJob(
          pool,
          env,
          async (request) => {
            calls++;
            const p = JSON.parse(request.prompt);
            if (calls === 1)
              return {
                candidates: [],
                incomplete: {
                  reason: "missing_critical_context",
                  atomIds: [p.atoms[0].id],
                },
              };
            expect(p.atoms).toHaveLength(2);
            expect(p.atoms.map((a: { text: string }) => a.text)).toContain(
              "Do not change until the official lineup is published.",
            );
            expect(request.prompt).not.toContain("supersecret");
            expect(request.prompt).not.toContain(otherEvent.id);
            return {
              candidates: [
                {
                  requestId: randomUUID(),
                  kind: "research_procedure",
                  scope: p.scope,
                  statement:
                    "Do not change until the official lineup is published.",
                  experienceIds: p.experienceIds,
                  evidence: p.atoms.map(
                    (a: {
                      id: string;
                      version: number;
                      hash: string;
                      text: string;
                    }) => ({
                      atomId: a.id,
                      version: a.version,
                      hash: a.hash,
                      stance: "support",
                      quote: a.text,
                    }),
                  ),
                  modelVersion: p.modelVersion,
                  promptVersion: p.promptVersion,
                  condition: {
                    type: "require_official_lineup",
                    expiresAt: "2027-01-01T00:00:00.000Z",
                  },
                },
              ],
            };
          },
          owner,
        ),
      ).toEqual({ checked: 1, completed: 1 });
      expect(calls).toBe(2);
      const row = (
        await pool.query(
          "SELECT j.* FROM learning_jobs j JOIN learning_experiences e ON e.user_id=j.user_id AND e.id=j.payload->>'id' WHERE j.user_id=$1 AND j.kind='extract' AND e.run_id=$2",
          [owner, current.id],
        )
      ).rows[0];
      expect(row.payload.initialIncomplete.reason).toBe(
        "MISSING_CRITICAL_CONTEXT",
      );
      expect(row.payload.contextExpansion.maxOriginalRuns).toBe(2);
      expect(row.payload.contextExpansion.omitted).toEqual([
        { runId: unsafe.id, reason: "UNSAFE_OR_OVERSIZED_ORIGINAL" },
      ]);
      expect(row.payload.generationTraces).toHaveLength(2);
      expect(row.payload.budgetAttempts).toHaveLength(2);
      const c = (
        await pool.query(
          "SELECT payload,status FROM lesson_candidates WHERE user_id=$1",
          [owner],
        )
      ).rows[0];
      expect(c.status).toBe("pending_review");
      expect(c.payload.experienceIds).toHaveLength(2);
    });
  },
);
