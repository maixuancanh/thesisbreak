import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { recordDecisionReceipt } from "../../packages/db/src/decision-receipt";
import { runOneReceiptPublication } from "../../packages/integrations/src/receipt-publication-worker";
import { publicDecisionReceipt } from "../../packages/domain/src/decision-receipt";
import type {
  MemoryRecord,
  MemoryEnvelope,
} from "../../packages/integrations/src/memwal";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "receipt publication exact reconciliation",
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
    async function fixture() {
      const run = await claimRun(pool, owner, {
        platform: "polymarket",
        nativeId: "123456",
        provider: "public",
        message: "Receipt fixture",
        requestId: randomUUID(),
      });
      await pool.query(
        "UPDATE conversations SET memory_consent=true WHERE user_id=$1 AND id=$2",
        [owner, run.conversationId],
      );
      await finishRun(pool, owner, run.id, { reply: {} }, "completed");
      const receipt = {
        id: run.id,
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
        publication: "pending",
        recordedAt: new Date().toISOString(),
      };
      await recordDecisionReceipt(pool, owner, receipt, {
        publicationConsent: true,
      });
      const row = (
        await pool.query(
          "SELECT * FROM decision_receipts WHERE user_id=$1 AND id=$2",
          [owner, run.id],
        )
      ).rows[0];
      const record: MemoryRecord = {
        logicalId: `decision-receipt:${run.id}`,
        type: "decision.receipt",
        version: 1,
        recordedAt: new Date(row.recorded_at).toISOString(),
        payload: publicDecisionReceipt(row.payload),
      };
      return { run, record };
    }
    it("reconciles exact prior readback without publication despite key reordering", async () => {
      const { record } = await fixture();
      const payload = Object.fromEntries(
        Object.entries(record.payload as Record<string, unknown>).reverse(),
      ) as MemoryRecord["payload"];
      const found: MemoryEnvelope = {
        ...record,
        payload,
        schema: 1,
        userId: owner,
        hash: "a".repeat(64),
      };
      let writes = 0;
      expect(
        await runOneReceiptPublication(
          pool,
          () => ({
            recall: async () => ({
              records: [found],
              sources: [
                {
                  record: found,
                  blobId: "exact-blob",
                  text: "verified adapter original",
                },
              ],
              conflicts: [],
              conflictingBlobs: [],
              rejected: 0,
              completeness: "unknown",
            }),
            remember: async () => {
              writes++;
              return {
                status: "verified" as const,
                blobId: "new",
                hash: "b".repeat(64),
              };
            },
            destroy: () => {},
          }),
          owner,
        ),
      ).toEqual({ checked: 1, verified: 1 });
      expect(writes).toBe(0);
    });
    it("does not mark verified after consent revoked during remote publication", async () => {
      const { run } = await fixture();
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
                blobId: "remote-written",
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
            [owner, run.id],
          )
        ).rows[0].publication_state,
      ).toBe("pending");
      expect(
        (
          await pool.query(
            "SELECT state FROM learning_jobs WHERE user_id=$1 AND kind='receipt_publish' AND operation_key=$2",
            [owner, run.id],
          )
        ).rows[0].state,
      ).toBe("retry");
    });
  },
);
