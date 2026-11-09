import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createPick,
  proposePick,
  confirmPick,
} from "../../packages/db/src/picks";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { rejectPickProposal } from "../../packages/db/src/decision-outcomes";
import { recordDecisionReceipt } from "../../packages/db/src/decision-receipt";
import { runOneDecisionReceiptPreparation } from "../../packages/integrations/src/decision-receipt-worker";
import { runOneReceiptPublication } from "../../packages/integrations/src/receipt-publication-worker";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "append-only final user decision receipts",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID(),
      other = randomUUID(),
      nativeId = "DECISION-" + randomUUID();
    let pickId = "";
    beforeAll(async () => {
      for (const id of [owner, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
      const saved = await createPick(
        pool,
        owner,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "Initial view",
          requestId: randomUUID(),
        },
        async () => ({
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
        }),
      );
      pickId = (saved as { pickId: string }).pickId;
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
      await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    });
    async function proposal() {
      const run = await claimRun(pool, owner, {
        platform: "kalshi",
        nativeId,
        provider: "public",
        message: "Check changing the saved view",
        requestId: randomUUID(),
      });
      await pool.query(
        "UPDATE conversations SET memory_consent=true WHERE id=$1 AND user_id=$2",
        [run.conversationId, owner],
      );
      await finishRun(
        pool,
        owner,
        run.id,
        {
          pick: {
            id: pickId,
            version: 1,
            outcome: "Yes",
            reason: "Initial view",
          },
          reply: {
            proposedChange: { baseVersion: 1, outcome: "No", reason: null },
          },
          verifiedLearningMemories: [],
        },
        "completed",
      );
      const p = await proposePick(pool, owner, pickId, {
        baseVersion: 1,
        requestId: randomUUID(),
        changes: { outcome: "No" },
        reason: "Evidence changed",
        sourceRunId: run.id,
      });
      return { run, proposalId: (p as { proposalId: string }).proposalId };
    }
    async function sourceReceipt(runId: string) {
      const receipt = {
        id: runId,
        ownerId: owner,
        eventId: "event",
        modelVersion: "fixture",
        promptVersion: "v1",
        memories: [],
        appliedConditions: [],
        requiredTools: [],
        selectedTools: [],
        executedTools: [],
        evidence: [],
        userDecision: "pending",
        publication: "pending",
        recordedAt: new Date().toISOString(),
      };
      await recordDecisionReceipt(pool, owner, receipt, {
        publicationConsent: true,
      });
      return (
        await pool.query(
          "SELECT * FROM decision_receipts WHERE user_id=$1 AND id=$2",
          [owner, runId],
        )
      ).rows[0];
    }
    it("records actual rejection once before initial receipt exists, then appends linked receipt without rewriting source", async () => {
      const { run, proposalId } = await proposal();
      const input = {
        proposalId,
        requestId: randomUUID(),
        confirmed: true as const,
      };
      await expect(
        rejectPickProposal(pool, other, pickId, input),
      ).rejects.toThrow("NOT_FOUND");
      const rejected = await rejectPickProposal(pool, owner, pickId, input);
      expect(await rejectPickProposal(pool, owner, pickId, input)).toEqual(
        rejected,
      );
      expect(await runOneDecisionReceiptPreparation(pool, owner)).toEqual({
        checked: 1,
        completed: 0,
      });
      const deferred = (
        await pool.query(
          "SELECT attempts,last_error FROM learning_jobs WHERE user_id=$1 AND kind='receipt_prepare_decision'",
          [owner],
        )
      ).rows[0];
      expect(deferred).toEqual({
        attempts: 0,
        last_error: "SOURCE_RECEIPT_PENDING",
      });
      const original = await sourceReceipt(run.id);
      await pool.query(
        "UPDATE learning_jobs SET retry_at=NULL WHERE user_id=$1 AND kind='receipt_prepare_decision'",
        [owner],
      );
      expect(await runOneDecisionReceiptPreparation(pool, owner)).toEqual({
        checked: 1,
        completed: 1,
      });
      const derived = (
        await pool.query(
          "SELECT * FROM decision_receipts WHERE user_id=$1 AND id=$2",
          [owner, rejected.decisionId],
        )
      ).rows[0];
      expect(derived.payload).toMatchObject({
        userDecision: "rejected",
        proposalId,
        sourceReceipt: { id: run.id, hash: original.payload_hash },
      });
      expect(
        (
          await pool.query(
            "SELECT payload_hash,payload FROM decision_receipts WHERE user_id=$1 AND id=$2",
            [owner, run.id],
          )
        ).rows[0],
      ).toEqual({
        payload_hash: original.payload_hash,
        payload: original.payload,
      });
      // Only derived publication is tested here; original publication stays a separate durable intent.
      await pool.query(
        "UPDATE learning_jobs SET state='completed' WHERE user_id=$1 AND kind='receipt_publish' AND operation_key=$2",
        [owner, run.id],
      );
      let writes = 0;
      expect(
        await runOneReceiptPublication(
          pool,
          () => ({
            recall: async () => ({
              records: [],
              sources: [],
              conflicts: [],
              conflictingBlobs: [],
              rejected: 0,
              completeness: "unknown",
            }),
            remember: async () => {
              await pool.query(
                "UPDATE conversations SET memory_consent=false WHERE user_id=$1 AND id=$2",
                [owner, run.conversationId],
              );
              return {
                status: "verified" as const,
                blobId: "uncommitted-remote",
                hash: "b".repeat(64),
              };
            },
            destroy: () => {},
          }),
          owner,
        ),
      ).toEqual({ checked: 1, verified: 0 });
      expect(
        (
          await pool.query(
            "SELECT publication_state FROM decision_receipts WHERE user_id=$1 AND id=$2",
            [owner, rejected.decisionId],
          )
        ).rows[0].publication_state,
      ).toBe("pending");
      await pool.query(
        "UPDATE conversations SET memory_consent=true WHERE user_id=$1 AND id=$2",
        [owner, run.conversationId],
      );
      await pool.query(
        "UPDATE learning_jobs SET retry_at=NULL WHERE user_id=$1 AND kind='receipt_publish' AND operation_key=$2",
        [owner, rejected.decisionId],
      );
      expect(
        await runOneReceiptPublication(
          pool,
          () => ({
            recall: async () => ({
              records: [],
              sources: [],
              conflicts: [],
              conflictingBlobs: [],
              rejected: 0,
              completeness: "unknown",
            }),
            remember: async (record) => {
              writes++;
              expect(record.payload).toMatchObject({
                userDecision: "rejected",
                sourceReceipt: { id: run.id },
              });
              return {
                status: "verified" as const,
                blobId: "derived",
                hash: "a".repeat(64),
              };
            },
            destroy: () => {},
          }),
          owner,
        ),
      ).toEqual({ checked: 1, verified: 1 });
      expect(writes).toBe(1);
    });
    it("confirmed outcome is linked to root owner and revoked current consent prevents derived publication", async () => {
      const { run, proposalId } = await proposal();
      const original = await sourceReceipt(run.id);
      await confirmPick(pool, owner, pickId, {
        proposalId,
        requestId: randomUUID(),
        confirmed: true,
      });
      expect(
        (
          await pool.query(
            "SELECT decision FROM decision_outcomes WHERE user_id=$1 AND proposal_id=$2",
            [owner, proposalId],
          )
        ).rows[0].decision,
      ).toBe("confirmed");
      await pool.query(
        "UPDATE conversations SET memory_consent=false WHERE user_id=$1 AND id=$2",
        [owner, run.conversationId],
      );
      expect(await runOneDecisionReceiptPreparation(pool, owner)).toEqual({
        checked: 1,
        completed: 1,
      });
      const derived = (
        await pool.query(
          "SELECT * FROM decision_receipts WHERE user_id=$1 AND payload->>'userDecision'='confirmed'",
          [owner],
        )
      ).rows[0];
      expect(derived.publication_state).toBe("not_requested");
      expect(derived.payload.sourceReceipt.hash).toBe(original.payload_hash);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM learning_jobs WHERE user_id=$1 AND kind='receipt_publish' AND operation_key=$2",
            [owner, derived.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });
  },
);
