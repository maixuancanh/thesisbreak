import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { runOneLearningJob } from "../../packages/integrations/src/learning-worker";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { MemoryRecord } from "../../packages/integrations/src/memwal";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createPick,
  proposePick,
  confirmPick,
} from "../../packages/db/src/picks";
import {
  listConfirmedActions,
  recordActionSettlement,
  syncOneActionMemory,
  recallActionHistory,
} from "../../packages/db/src/action-history";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "confirmed action lifecycle",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID(),
      other = randomUUID(),
      nativeId = "ACTIONS-" + randomUUID();
    let pickId: string;
    beforeAll(async () => {
      for (const id of [owner, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
      const saved = (await createPick(
        pool,
        owner,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "Original reason",
          requestId: randomUUID(),
        },
        async () => ({
          platform: "kalshi",
          nativeId,
          eventId: null,
          question: "Test fixture",
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
          raw: { scheduledAt: new Date(Date.now() + 3600000).toISOString() },
        }),
      )) as { pickId: string };
      pickId = saved.pickId;
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
      await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    });
    it("records only accepted actions, isolates owners, versions corrections, and fences revoked recall", async () => {
      const proposal = (await proposePick(pool, owner, pickId, {
        baseVersion: 1,
        requestId: randomUUID(),
        changes: { outcome: "No", reason: "Official report changed" },
        reason: "Reviewed evidence",
      })) as { proposalId: string };
      expect(await listConfirmedActions(pool, owner)).toEqual([]);
      await confirmPick(pool, owner, pickId, {
        proposalId: proposal.proposalId,
        requestId: randomUUID(),
        confirmed: true,
      });
      expect(await listConfirmedActions(pool, other)).toEqual([]);
      expect((await listConfirmedActions(pool, owner))[0]?.status).toBe(
        "pending_or_unscorable",
      );
      // Isolated test-only historical fixture. Production APIs never accept capture timestamps.
      await pool.query(
        "UPDATE pick_versions SET created_at=clock_timestamp()-interval '3 hours' WHERE pick_id=$1",
        [pickId],
      );
      await pool.query(
        "UPDATE market_snapshots SET raw=jsonb_build_object('scheduledAt',to_char((clock_timestamp()-interval '2 hours') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) WHERE id=(SELECT snapshot_id FROM pick_versions WHERE pick_id=$1 LIMIT 1)",
        [pickId],
      );
      const input = {
        winner: "No",
        status: "final" as const,
        rulesHash: "fixture",
        sourceUrl: "https://kalshi.com/markets/result",
        retrievedAt: new Date().toISOString(),
      };
      await recordActionSettlement(pool, pickId, input);
      await recordActionSettlement(pool, pickId, input);
      expect((await listConfirmedActions(pool, owner))[0]).toMatchObject({
        beforeMatched: false,
        afterMatched: true,
        improvementEstablished: false,
      });
      let record!: MemoryRecord;
      const writer = () => ({
        remember: async (r: MemoryRecord) => {
          record = r;
          return { status: "verified", blobId: "exact", hash: "a".repeat(64) };
        },
        destroy: () => {},
      });
      expect(await syncOneActionMemory(pool, writer)).toEqual({
        checked: 0,
        verified: 0,
      });
      await pool.query(
        "INSERT INTO action_memory_preferences(user_id,memory_consent) VALUES($1,true)",
        [owner],
      );
      expect(await syncOneActionMemory(pool, writer)).toEqual({
        checked: 1,
        verified: 1,
      });
      const remote = async () => ({
        sources: [
          { blobId: "exact", record: { ...record, hash: "a".repeat(64) } },
        ],
      });
      expect(await recallActionHistory(pool, owner, remote)).toHaveLength(1);
      expect(
        await recallActionHistory(pool, owner, async () => ({
          sources: [
            { blobId: "wrong", record: { ...record, hash: "a".repeat(64) } },
          ],
        })),
      ).toEqual([]);
      expect(
        await recallActionHistory(pool, owner, async () => ({
          sources: [
            {
              blobId: "exact",
              record: { ...record, hash: "a".repeat(64), type: "source.score" },
            },
          ],
        })),
      ).toEqual([]);
      expect(
        await recallActionHistory(pool, owner, async () => {
          await pool.query(
            "UPDATE action_memory_preferences SET memory_consent=false WHERE user_id=$1",
            [owner],
          );
          return remote();
        }),
      ).toEqual([]);
      await pool.query(
        "UPDATE action_memory_preferences SET memory_consent=true WHERE user_id=$1",
        [owner],
      );
      const learningRun = await claimRun(pool, owner, {
        platform: "kalshi",
        nativeId,
        provider: "public",
        message:
          "Record the corrected final result with its original decision.",
        requestId: randomUUID(),
      });
      await pool.query(
        "UPDATE conversations SET memory_consent=true WHERE user_id=$1 AND id=$2",
        [owner, learningRun.conversationId],
      );
      await finishRun(
        pool,
        owner,
        learningRun.id,
        {
          reply: {},
          modelVersion: "fixture",
          learningTrigger: "explicit_correction",
          promptVersion: "fixture",
        },
        "completed",
      );
      await recordActionSettlement(pool, pickId, { ...input, winner: "Yes" });
      const queued = (
        await pool.query(
          "SELECT * FROM learning_jobs WHERE user_id=$1 AND kind='capture_settlement'",
          [owner],
        )
      ).rows;
      expect(queued).toHaveLength(1);
      await recordActionSettlement(pool, pickId, { ...input, winner: "Yes" });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM learning_jobs WHERE user_id=$1 AND kind='capture_settlement'",
            [owner],
          )
        ).rows[0].n,
      ).toBe(1);
      for (let i = 0; i < 4; i++)
        await runOneLearningJob(
          pool,
          { LEARNING_DAILY_ATTEMPTS: "10000" },
          async () => ({ candidates: [] }),
          owner,
        );
      const captured = (
        await pool.query(
          "SELECT payload FROM memory_atoms WHERE user_id=$1 AND payload->>'origin'='verified_outcome'",
          [owner],
        )
      ).rows;
      expect(captured).toHaveLength(1);
      expect(captured[0].payload.reference).toBe(`action:${pickId}:2`);
      expect(JSON.parse(captured[0].payload.text)).toMatchObject({
        winner: "Yes",
        improvementEstablished: false,
      });

      expect((await listConfirmedActions(pool, owner))[0]).toMatchObject({
        beforeMatched: true,
        afterMatched: false,
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM confirmed_action_results WHERE pick_id=$1",
            [pickId],
          )
        ).rows[0].n,
      ).toBe(2);
      // A new official result can arrive while remote recall is in flight.
      // Exact old bytes are no longer current authority after that correction.
      expect(await syncOneActionMemory(pool, writer)).toEqual({
        checked: 1,
        verified: 1,
      });
      expect(
        await recallActionHistory(pool, owner, async () => {
          const old = await remote();
          await recordActionSettlement(pool, pickId, {
            ...input,
            winner: "No",
            retrievedAt: new Date().toISOString(),
          });
          return old;
        }),
      ).toEqual([]);
    });
  },
);
