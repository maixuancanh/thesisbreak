import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { runOneLearningJob } from "../../packages/integrations/src/learning-worker";
import type { GenerateReply } from "../../packages/agent/src/context";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("durable capture/extraction worker", () => {
  const pool = new Pool({ connectionString: url }),
    owner = randomUUID();
  let sessionId = "";
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
      owner,
    ]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=$1", [owner]);
    await pool.end();
  });
  async function complete(message: string) {
    const run = await claimRun(pool, owner, {
      platform: "polymarket",
      nativeId: "123456",
      provider: "public",
      message,
      requestId: randomUUID(),
    });
    sessionId = run.conversationId;
    await pool.query(
      "UPDATE conversations SET memory_consent=true WHERE user_id=$1 AND id=$2",
      [owner, sessionId],
    );
    await finishRun(
      pool,
      owner,
      run.id,
      {
        modelVersion: "fixture",
        learningTrigger: "explicit_correction",
        promptVersion: "research-fixture",
        reply: {},
        learningEvidence: [
          {
            id: "official",
            text: "Official report: starters confirmed.",
            retrievedAt: new Date().toISOString(),
            publishedAt: null,
            occurredAt: null,
            sourceOrigin: "official.example",
          },
        ],
      },
      "completed",
    );
    return run;
  }
  const generated: GenerateReply = async (request) => {
    const p = JSON.parse(request.prompt);
    const atom =
      p.atoms.find((a: { origin: string }) => a.origin === "tool_result") ??
      p.atoms[0];
    return {
      candidates: [
        {
          requestId: randomUUID(),
          kind: "research_procedure",
          scope: p.scope,
          statement: "Require official lineup before changing the saved pick",
          experienceIds: [p.experienceId],
          evidence: [
            {
              atomId: atom.id,
              version: atom.version,
              hash: atom.hash,
              stance: "support",
              quote: atom.text,
            },
          ],
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
  it("captures exact user and authoritative tool originals, extracts once and persists failures/revocation", async () => {
    await complete("Wait for official lineup before changing.");
    expect(
      await runOneLearningJob(
        pool,
        { LEARNING_DAILY_ATTEMPTS: "10000" },
        generated,
        owner,
      ),
    ).toEqual({
      checked: 1,
      completed: 1,
    });
    const exp = (
      await pool.query(
        "SELECT payload FROM learning_experiences WHERE user_id=$1",
        [owner],
      )
    ).rows[0].payload;
    expect(exp.atoms.map((a: { origin: string }) => a.origin).sort()).toEqual([
      "tool_result",
      "user_statement",
    ]);
    expect(
      await runOneLearningJob(
        pool,
        { LEARNING_DAILY_ATTEMPTS: "10000" },
        generated,
        owner,
      ),
    ).toEqual({
      checked: 1,
      completed: 1,
    });
    expect(
      (
        await pool.query(
          "SELECT status FROM lesson_candidates WHERE user_id=$1",
          [owner],
        )
      ).rows,
    ).toEqual([{ status: "pending_review" }]);
    expect(
      await runOneLearningJob(
        pool,
        { LEARNING_DAILY_ATTEMPTS: "10000" },
        generated,
        owner,
      ),
    ).toEqual({
      checked: 0,
      completed: 0,
    });
    await complete("Different correction: require a fresh quote.");
    await runOneLearningJob(
      pool,
      { LEARNING_DAILY_ATTEMPTS: "10000" },
      generated,
      owner,
    );
    expect(
      await runOneLearningJob(
        pool,
        { LEARNING_DAILY_ATTEMPTS: "10000" },
        async () => {
          throw Error("model offline");
        },
        owner,
      ),
    ).toEqual({ checked: 1, completed: 0 });
    expect(
      (
        await pool.query(
          "SELECT state,last_error FROM learning_jobs WHERE user_id=$1 AND state='retry'",
          [owner],
        )
      ).rows,
    ).toEqual([
      { state: "retry", last_error: "EXTRACTION_OR_PROVIDER_FAILED" },
    ]);
    const failedPayload = (
      await pool.query(
        "SELECT payload FROM learning_jobs WHERE user_id=$1 AND state='retry'",
        [owner],
      )
    ).rows[0].payload;
    expect(failedPayload.budgetAttempts).toHaveLength(1);
    expect(failedPayload.budgetAttempts[0].unit).toBe("bounded_model_attempt");
    expect(failedPayload.generationTraces).toHaveLength(1);
    expect(failedPayload.generationTraces[0]).toMatchObject({
      status: "failed",
      source: "injected_generator",
      actualTokenUsage: null,
    });
    await complete("Third original user statement.");
    await runOneLearningJob(
      pool,
      { LEARNING_DAILY_ATTEMPTS: "10000" },
      generated,
      owner,
    );
    expect(
      await runOneLearningJob(
        pool,
        { LEARNING_DAILY_ATTEMPTS: "10000" },
        async (request) => {
          await pool.query(
            "UPDATE conversations SET memory_consent=false WHERE user_id=$1 AND id=$2",
            [owner, sessionId],
          );
          return generated(request);
        },
        owner,
      ),
    ).toEqual({ checked: 1, completed: 1 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM lesson_candidates WHERE user_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(1);
    await complete("Fourth: check original sources on every reconsideration.");
    await runOneLearningJob(
      pool,
      { LEARNING_DAILY_ATTEMPTS: "10000" },
      generated,
      owner,
    );
    expect(
      await runOneLearningJob(
        pool,
        { LEARNING_DAILY_ATTEMPTS: "10000" },
        async (request) => {
          await pool.query(
            "UPDATE learning_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND state='processing'",
            [owner],
          );
          return generated(request);
        },
        owner,
      ),
    ).toEqual({ checked: 1, completed: 0 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM lesson_candidates WHERE user_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      await runOneLearningJob(
        pool,
        { LEARNING_DAILY_ATTEMPTS: "10000" },
        generated,
        owner,
      ),
    ).toEqual({
      checked: 1,
      completed: 1,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM lesson_candidates WHERE user_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(2);
  });
});
