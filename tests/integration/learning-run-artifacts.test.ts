import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { runOneReceiptPreparation } from "../../packages/integrations/src/run-receipt-worker";
import { runOneEventDossierJob } from "../../packages/integrations/src/event-dossier-worker";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("completed-run learning artifacts", () => {
  const pool = new Pool({ connectionString: url }),
    user = randomUUID();
  let runId = "";
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
      user,
    ]);
    const r = await claimRun(pool, user, {
      platform: "kalshi",
      nativeId: "ARTIFACT",
      provider: "public",
      message: "Review my event",
      requestId: randomUUID(),
    });
    runId = r.id;
    await pool.query(
      "UPDATE conversations SET memory_consent=true WHERE user_id=$1 AND id=$2",
      [user, r.conversationId],
    );
    await finishRun(
      pool,
      user,
      r.id,
      {
        reply: {
          message: "Waiting",
          evidenceRefs: [],
          lessonRefs: [],
          proposedChange: null,
        },
        learningEventId: "artifact-event",
        learningEvidence: [
          {
            id: "official",
            text: "Original actual tool result",
            origin: "tool_result",
            eventId: "artifact-event",
            publishedAt: null,
            occurredAt: null,
            retrievedAt: new Date().toISOString(),
            sourceOrigin: "official",
          },
        ],
        verifiedLearningLessons: [],
        verifiedLearningMemories: [],
        learningSourceMemories: [],
        pick: null,
        appliedConditions: [],
        learningGate: { ready: false, reasons: ["official_lineup_required"] },
        recalledSources: [],
        modelVersion: "test",
        promptVersion: "test",
        policyRequiredTools: ["read_independent_sources"],
        plannedTools: [],
        trace: [
          {
            tool: "read_independent_sources",
            status: "completed",
            count: 1,
            startedAt: "2026-10-30T00:00:00.000Z",
            completedAt: "2026-10-30T00:00:00.001Z",
            observedAt: "2026-10-29T23:00:00.000Z",
            resultHash: "a".repeat(64),
            observationKind: "retrieval_timestamp",
          },
        ],
        researchAudit: { proposalWithheld: true },
      },
      "completed",
    );
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=$1", [user]);
    await pool.end();
  });
  it("commits scoped dossier and immutable receipt through durable jobs and reconciles retry", async () => {
    expect(await runOneEventDossierJob(pool, user)).toEqual({
      checked: 1,
      completed: 1,
    });
    const dossier = (
      await pool.query(
        "SELECT payload FROM event_dossier_versions WHERE user_id=$1 AND event_id=$2",
        [user, "artifact-event"],
      )
    ).rows[0].payload;
    expect(dossier.blocks.evidence.text).toContain(
      "Original actual tool result",
    );
    expect(await runOneReceiptPreparation(pool, user)).toEqual({
      checked: 1,
      completed: 1,
    });
    const receipt = (
      await pool.query(
        "SELECT payload FROM decision_receipts WHERE user_id=$1 AND id=$2",
        [user, runId],
      )
    ).rows[0].payload;
    expect(receipt.requiredTools).toEqual(["read_independent_sources"]);
    expect(receipt.memories).toEqual([]);
    expect(receipt.executedTools[0].observedAt).toBe(
      "2026-10-29T23:00:00.000Z",
    );
    expect(receipt.executedTools[0].resultHash).toBe("a".repeat(64));
    expect(receipt.executedTools[0].startedAt).toBe("2026-10-30T00:00:00.000Z");
    await pool.query(
      "UPDATE learning_jobs SET state='retry',retry_at=null WHERE user_id=$1 AND kind='receipt_prepare'",
      [user],
    );
    expect(await runOneReceiptPreparation(pool, user)).toEqual({
      checked: 1,
      completed: 1,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM decision_receipts WHERE user_id=$1",
          [user],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("patches exact changed evidence only, preserves old revisions and retains failed refresh", async () => {
    const initial = (
      await pool.query(
        "SELECT payload FROM event_dossier_versions WHERE user_id=$1 ORDER BY revision DESC LIMIT 1",
        [user],
      )
    ).rows[0].payload;
    await pool.query(
      "UPDATE agent_runs SET result=jsonb_set(result,'{learningEvidence,0,text}','\"Corrected actual tool result\"'::jsonb),finished_at=clock_timestamp() WHERE user_id=$1 AND id=$2",
      [user, runId],
    );
    await pool.query(
      "UPDATE learning_jobs SET state='retry',retry_at=null WHERE user_id=$1 AND kind='dossier_refresh'",
      [user],
    );
    expect(await runOneEventDossierJob(pool, user)).toEqual({
      checked: 1,
      completed: 1,
    });
    const revisions = (
      await pool.query(
        "SELECT payload FROM event_dossier_versions WHERE user_id=$1 ORDER BY revision",
        [user],
      )
    ).rows;
    expect(revisions).toHaveLength(2);
    expect(revisions[0].payload).toEqual(initial);
    expect(revisions[1].payload.blocks.evidence.text).toContain(
      "Corrected actual tool result",
    );
    expect(revisions[1].payload.blocks.savedView).toEqual(
      initial.blocks.savedView,
    );
    expect(revisions[1].payload.blocks.conditions).toEqual(
      initial.blocks.conditions,
    );
    expect(revisions[1].payload.blocks.sourceHistory).toEqual(
      initial.blocks.sourceHistory,
    );
    await pool.query(
      "UPDATE learning_jobs SET state='retry',retry_at=null WHERE user_id=$1 AND kind='dossier_refresh'",
      [user],
    );
    expect(await runOneEventDossierJob(pool, user)).toEqual({
      checked: 1,
      completed: 1,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM event_dossier_versions WHERE user_id=$1",
          [user],
        )
      ).rows[0].n,
    ).toBe(2);
    await pool.query(
      "UPDATE agent_runs SET result=jsonb_set(result,'{learningEvidence,0,eventId}','\"foreign-event\"'::jsonb),finished_at=clock_timestamp() WHERE user_id=$1 AND id=$2",
      [user, runId],
    );
    await pool.query(
      "UPDATE learning_jobs SET state='retry',retry_at=null WHERE user_id=$1 AND kind='dossier_refresh'",
      [user],
    );
    expect(await runOneEventDossierJob(pool, user)).toEqual({
      checked: 1,
      completed: 0,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM event_dossier_versions WHERE user_id=$1",
          [user],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT state,last_error FROM learning_jobs WHERE user_id=$1 AND kind='dossier_refresh'",
          [user],
        )
      ).rows[0],
    ).toMatchObject({ state: "retry", last_error: "DOSSIER_REFRESH_FAILED" });
  });
});
