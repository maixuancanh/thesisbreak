import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEventDossier,
  patchEventDossier,
  readEventDossier,
} from "../../packages/db/src/event-dossier";
import {
  queueDependentReviews,
  recordDecisionDependencies,
} from "../../packages/db/src/decision-dependencies";
import {
  recordDecisionReceipt,
  readDecisionReceipt,
} from "../../packages/db/src/decision-receipt";
import {
  createPick,
  proposePick,
  confirmPick,
} from "../../packages/db/src/picks";
import {
  runOneAdviceReviewJob,
  listAdviceReviews,
} from "../../packages/integrations/src/advice-review-worker";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "decision evidence persistence",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      userId = randomUUID(),
      other = randomUUID(),
      eventId = randomUUID();
    const dep = {
      id: randomUUID(),
      version: 1,
      hash: "a".repeat(64),
      status: "current" as const,
    };
    beforeAll(async () => {
      for (const id of [userId, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[userId, other]]);
      await pool.end();
    });
    it("preserves revision history and isolates foreign users", async () => {
      const initial = {
        ownerId: userId,
        eventId,
        revision: 1,
        checkedAt: new Date().toISOString(),
        blocks: { reasons: { text: "original", dependencies: [dep] } },
      };
      await createEventDossier(pool, userId, initial);
      expect(await readEventDossier(pool, other, eventId)).toBeNull();
      const patch = {
        ownerId: userId,
        eventId,
        baseRevision: 1,
        checkedAt: initial.checkedAt,
        changes: {
          unknowns: { text: "pending official read", dependencies: [] },
        },
      };
      expect(
        (await patchEventDossier(pool, userId, eventId, patch)).revision,
      ).toBe(2);
      await expect(
        patchEventDossier(pool, userId, eventId, patch),
      ).rejects.toThrow("REVISION_CONFLICT");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM event_dossier_versions WHERE user_id=$1 AND event_id=$2",
            [userId, eventId],
          )
        ).rows[0].n,
      ).toBe(2);
    });
    it("deduplicates exact correction notifications and honors monitoring/consent", async () => {
      for (const [id, monitoring, consent] of [
        ["active", true, true],
        ["disabled", false, true],
        ["revoked", true, false],
      ] as const)
        await recordDecisionDependencies(pool, {
          userId,
          decisionId: id,
          eventId,
          monitoring,
          consent,
          dependencies: [dep],
        });
      const changed = { ...dep, version: 2, status: "unavailable" as const };
      expect(await queueDependentReviews(pool, other, changed)).toEqual([]);
      expect(await queueDependentReviews(pool, userId, changed)).toHaveLength(
        1,
      );
      expect(await queueDependentReviews(pool, userId, changed)).toEqual([]);
      const job = (
        await pool.query(
          "SELECT payload FROM learning_jobs WHERE user_id=$1 AND kind='advice_review'",
          [userId],
        )
      ).rows[0];
      expect(job.payload.decisionId).toBe("active");
      expect(job.payload.status).toBe("unavailable");
      expect(await runOneAdviceReviewJob(pool)).toEqual({
        checked: 1,
        completed: 1,
      });
      const reviews = await listAdviceReviews(pool, userId, "active");
      expect(reviews).toHaveLength(1);
      expect(reviews[0].explanation).toContain("does not establish");
      expect(await listAdviceReviews(pool, other, "active")).toEqual([]);
      expect(
        await queueDependentReviews(pool, userId, { ...changed, version: 3 }),
      ).toHaveLength(1);
      await pool.query(
        "UPDATE decision_dependencies SET consent=false WHERE user_id=$1 AND decision_id='active'",
        [userId],
      );
      expect(await runOneAdviceReviewJob(pool)).toEqual({
        checked: 1,
        completed: 1,
      });
      expect((await listAdviceReviews(pool, userId, "active"))[0].state).toBe(
        "monitoring_disabled",
      );
    });
    it("atomically records immutable receipt plus one durable publication operation", async () => {
      const receipt = {
        id: randomUUID(),
        ownerId: userId,
        eventId,
        modelVersion: "fixture",
        promptVersion: "v1",
        memories: [],
        appliedConditions: [],
        requiredTools: [],
        selectedTools: [],
        executedTools: [],
        evidence: [],
        publication: "pending",
        recordedAt: new Date().toISOString(),
      };
      await recordDecisionReceipt(pool, userId, receipt, {
        publicationConsent: true,
      });
      expect(await readDecisionReceipt(pool, other, receipt.id)).toBeNull();
      const publicReceipt = await readDecisionReceipt(pool, userId, receipt.id);
      expect(publicReceipt?.receipt).not.toHaveProperty("ownerId");
      expect(publicReceipt?.proof.exactRecordBinding).toBe("unsupported");
      expect(publicReceipt?.publication).toBe("pending");
      await recordDecisionReceipt(pool, userId, receipt, {
        publicationConsent: true,
      });
      await expect(recordDecisionReceipt(pool, other, receipt)).rejects.toThrow(
        "FORBIDDEN",
      );
      await expect(
        recordDecisionReceipt(pool, userId, {
          ...receipt,
          promptVersion: "changed",
        }),
      ).rejects.toThrow("RECEIPT_IDEMPOTENCY_CONFLICT");
      const result = await pool.query(
        "SELECT count(*)::int AS n FROM learning_jobs WHERE user_id=$1 AND kind='receipt_publish' AND operation_key=$2",
        [userId, receipt.id],
      );
      expect(result.rows[0].n).toBe(1);
    });
    it("rejects changed provider evidence at confirmation without changing the proposal", async () => {
      const nativeId = `EVIDENCE-${randomUUID()}`;
      const snapshot = {
        platform: "kalshi",
        nativeId,
        eventId: null,
        question: "Fixture",
        outcomes: [
          { name: "Yes", price: 0.5 },
          { name: "No", price: 0.5 },
        ],
        rulesReference: "https://kalshi.com",
        rulesHash: "old-rules",
        closeTime: null,
        fetchedAt: new Date().toISOString(),
        priceAsOf: null,
        nativeUnit: "probability",
        raw: { scheduledAt: new Date(Date.now() + 86400000).toISOString() },
      };
      const pick = (await createPick(
        pool,
        userId,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "fixture",
          requestId: randomUUID(),
        },
        async () => snapshot,
      )) as { pickId: string };
      const proposal = (await proposePick(pool, userId, pick.pickId, {
        baseVersion: 1,
        requestId: randomUUID(),
        changes: { outcome: "No" },
        reason: "change fixture",
      })) as { proposalId: string };
      await expect(
        proposePick(pool, userId, pick.pickId, {
          baseVersion: 1,
          requestId: randomUUID(),
          changes: { outcome: "No" },
          reason: "foreign run",
          sourceRunId: randomUUID(),
        }),
      ).rejects.toThrow("SOURCE_RUN_MISMATCH");
      await expect(
        confirmPick(
          pool,
          userId,
          pick.pickId,
          {
            proposalId: proposal.proposalId,
            requestId: randomUUID(),
            confirmed: true,
          },
          { ...snapshot, rulesHash: "new-rules" },
        ),
      ).rejects.toThrow("EVIDENCE_REVIEW_REQUIRED");
      expect(
        (
          await pool.query("SELECT status FROM change_proposals WHERE id=$1", [
            proposal.proposalId,
          ])
        ).rows[0].status,
      ).toBe("pending");
      await confirmPick(
        pool,
        userId,
        pick.pickId,
        {
          proposalId: proposal.proposalId,
          requestId: randomUUID(),
          confirmed: true,
        },
        snapshot,
      );
    });
    it("binds a proposal to its exact research run and fences consent revocation", async () => {
      const nativeId = `RUN-${randomUUID()}`,
        sessionId = randomUUID(),
        runId = randomUUID(),
        lessonId = randomUUID();
      const snapshot = {
        platform: "kalshi",
        nativeId,
        eventId: null,
        question: "Fixture",
        outcomes: [
          { name: "Yes", price: 0.5 },
          { name: "No", price: 0.5 },
        ],
        rulesReference: "https://kalshi.com",
        rulesHash: "fixture",
        closeTime: null,
        fetchedAt: new Date().toISOString(),
        priceAsOf: null,
        nativeUnit: "probability",
        raw: { scheduledAt: new Date(Date.now() + 86400000).toISOString() },
      };
      const pick = (await createPick(
        pool,
        userId,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "fixture",
          requestId: randomUUID(),
        },
        async () => snapshot,
      )) as { pickId: string };
      await pool.query(
        "INSERT INTO conversations(id,user_id,platform,native_id,memory_consent) VALUES($1,$2,'kalshi',$3,true)",
        [sessionId, userId, nativeId],
      );
      await pool.query("INSERT INTO lessons(id,user_id) VALUES($1,$2)", [
        lessonId,
        userId,
      ]);
      await pool.query(
        "INSERT INTO lesson_versions(lesson_id,user_id,version,rule,scope,approval,status,effective_at) VALUES($1,$2,1,'Check quote','{}','approved','active',clock_timestamp())",
        [lessonId, userId],
      );
      await pool.query(
        "INSERT INTO outbox(operation_key,user_id,kind,payload) VALUES($1,$2,'lesson.version.created',$3)",
        [
          randomUUID(),
          userId,
          JSON.stringify({ lessonId, version: 1, memoryConsent: true }),
        ],
      );
      const result = {
        pick: { id: pick.pickId, version: 1 },
        reply: {
          proposedChange: { baseVersion: 1, outcome: "No", reason: null },
        },
        verifiedLearningMemories: [
          { id: lessonId, version: 1, hash: "a".repeat(64) },
        ],
      };
      await pool.query(
        "INSERT INTO agent_runs(id,user_id,conversation_id,request_id,payload_hash,provider,message,status,platform,native_id,result) VALUES($1,$2,$3,$4,'fixture','public','fixture','completed','kalshi',$5,$6)",
        [
          runId,
          userId,
          sessionId,
          randomUUID(),
          nativeId,
          JSON.stringify(result),
        ],
      );
      const proposal = (await proposePick(pool, userId, pick.pickId, {
        baseVersion: 1,
        requestId: randomUUID(),
        changes: { outcome: "No" },
        reason: "fixture",
        sourceRunId: runId,
      })) as { proposalId: string };
      await pool.query(
        "UPDATE conversations SET memory_consent=false WHERE id=$1",
        [sessionId],
      );
      await expect(
        confirmPick(
          pool,
          userId,
          pick.pickId,
          {
            proposalId: proposal.proposalId,
            requestId: randomUUID(),
            confirmed: true,
          },
          snapshot,
        ),
      ).rejects.toThrow("MEMORY_REVIEW_REQUIRED");
      await pool.query(
        "UPDATE conversations SET memory_consent=true WHERE id=$1",
        [sessionId],
      );
      await pool.query(
        "UPDATE lesson_versions SET status='paused' WHERE lesson_id=$1 AND version=1",
        [lessonId],
      );
      await expect(
        confirmPick(
          pool,
          userId,
          pick.pickId,
          {
            proposalId: proposal.proposalId,
            requestId: randomUUID(),
            confirmed: true,
          },
          snapshot,
        ),
      ).rejects.toThrow("MEMORY_REVIEW_REQUIRED");
    });
  },
);
