import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { runOneLearningJob } from "../../packages/integrations/src/learning-worker";
import type { GenerateReply } from "../../packages/agent/src/context";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "idle bounded session extraction batches",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID(),
      other = randomUUID();
    beforeAll(async () => {
      for (const id of [owner, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
      await pool.end();
    });
    async function complete(
      ownerId: string,
      message: string,
      eventId: string,
      sessionId?: string,
      immediate = false,
    ) {
      const r = await claimRun(pool, ownerId, {
        platform: "polymarket",
        nativeId: eventId,
        provider: "public",
        message,
        requestId: randomUUID(),
        ...(sessionId ? { sessionId } : {}),
      });
      await pool.query(
        "UPDATE conversations SET memory_consent=true WHERE user_id=$1 AND id=$2",
        [ownerId, r.conversationId],
      );
      await finishRun(
        pool,
        ownerId,
        r.id,
        {
          reply: {},
          modelVersion: "research-fixture",
          learningEventId: eventId,
          ...(immediate ? { learningTrigger: "explicit_correction" } : {}),
        },
        "completed",
      );
      return r;
    }
    it("waits for idle, uses one bounded generation for exact same-event originals and excludes foreign events/owners", async () => {
      const first = await complete(
        owner,
        "Do not change until the official lineup.",
        "111",
      );
      await complete(
        owner,
        "This same event also needs a fresh quote.",
        "111",
        first.conversationId,
      );
      await complete(
        owner,
        "Different event must stay separate.",
        "222",
        first.conversationId,
      );
      await complete(other, "Foreign owner data must not appear.", "111");
      for (let i = 0; i < 6; i++)
        await runOneLearningJob(
          pool,
          { LEARNING_DAILY_ATTEMPTS: "10000" },
          async () => {
            throw Error("idle batch must not invoke model");
          },
          owner,
        );
      let calls = 0;
      const generate: GenerateReply = async (request) => {
        calls++;
        const p = JSON.parse(request.prompt);
        expect(p.experienceIds).toHaveLength(2);
        expect(p.sourceExperiences).toHaveLength(2);
        expect(p.atoms.map((a: { text: string }) => a.text).sort()).toEqual([
          "Do not change until the official lineup.",
          "This same event also needs a fresh quote.",
        ]);
        return {
          candidates: [
            {
              requestId: randomUUID(),
              kind: "research_procedure",
              scope: p.scope,
              statement:
                "Check official lineup and fresh quote for this event.",
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
      };
      await runOneLearningJob(
        pool,
        { LEARNING_DAILY_ATTEMPTS: "10000" },
        generate,
        owner,
      );
      expect(calls).toBe(0);
      await pool.query(
        "UPDATE conversations SET updated_at=clock_timestamp()-interval '3 minutes' WHERE user_id=$1 AND id=$2",
        [owner, first.conversationId],
      );
      await pool.query(
        "UPDATE learning_jobs SET retry_at=NULL WHERE user_id=$1 AND kind='extract'",
        [owner],
      );
      expect(
        await runOneLearningJob(
          pool,
          { LEARNING_DAILY_ATTEMPTS: "10000" },
          generate,
          owner,
        ),
      ).toEqual({
        checked: 1,
        completed: 1,
      });
      expect(calls).toBe(1);
      const candidates = (
        await pool.query(
          "SELECT payload,status FROM lesson_candidates WHERE user_id=$1",
          [owner],
        )
      ).rows;
      expect(candidates).toHaveLength(1);
      expect(candidates[0].status).toBe("pending_review");
      expect(candidates[0].payload.experienceIds).toHaveLength(2);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM learning_jobs WHERE user_id=$1 AND last_error='BATCHED_IN_PRIMARY'",
            [owner],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM memory_atoms WHERE user_id=$1",
            [owner],
          )
        ).rows[0].n,
      ).toBe(3);
      // The unrelated event remains its own exact-scope job and may complete without producing a rule.
      await runOneLearningJob(
        pool,
        {},
        async (request) => {
          const p = JSON.parse(request.prompt);
          expect(p.scope.eventId).toBe("222");
          return { candidates: [] };
        },
        owner,
      );
    });
    it("explicit corrections bypass idle and missing critical context stays inspectably incomplete", async () => {
      const run = await complete(
        owner,
        "Correction: this refers to the same earlier official statement.",
        "333",
        undefined,
        true,
      );
      await runOneLearningJob(
        pool,
        {},
        async () => ({ candidates: [] }),
        owner,
      );
      let calls = 0;
      expect(
        await runOneLearningJob(
          pool,
          { LEARNING_DAILY_ATTEMPTS: "10000" },
          async (request) => {
            calls++;
            const p = JSON.parse(request.prompt);
            expect(p.experienceIds).toHaveLength(1);
            return {
              candidates: [],
              incomplete: {
                reason: "missing_critical_context",
                atomIds: [p.atoms[0].id],
              },
            };
          },
          owner,
        ),
      ).toEqual({ checked: 1, completed: 1 });
      expect(calls).toBe(1);
      const job = (
        await pool.query(
          "SELECT j.* FROM learning_jobs j JOIN learning_experiences e ON e.id=j.payload->>'id' AND e.user_id=j.user_id WHERE j.user_id=$1 AND j.kind='extract' AND e.run_id=$2",
          [owner, run.id],
        )
      ).rows[0];
      expect(job.last_error).toBe("EXTRACTION_INCOMPLETE");
      expect(job.payload.extraction.status).toBe("incomplete");
      expect(job.payload.extraction.omittedAtomIds).toHaveLength(1);
      await pool.query(
        "UPDATE learning_jobs SET state='retry',retry_at=NULL WHERE id=$1",
        [job.id],
      );
      await runOneLearningJob(
        pool,
        {},
        async () => {
          throw Error("STAGED_REPLAY_MUST_NOT_CALL_MODEL");
        },
        owner,
      );
      expect(
        (
          await pool.query("SELECT last_error FROM learning_jobs WHERE id=$1", [
            job.id,
          ])
        ).rows[0].last_error,
      ).toBe("EXTRACTION_INCOMPLETE");
    });
  },
);
