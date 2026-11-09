import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPick,
  readPicks,
  proposePick,
  confirmPick,
  type Snapshot,
} from "../../packages/db/src/picks";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "pick persistence (requires migrated TEST_DATABASE_URL)",
  () => {
    const pool = new Pool({ connectionString: url });
    const user = randomUUID(),
      foreign = randomUUID(),
      nativeId = `PICKTEST-${randomUUID()}`;
    const snapshot: Snapshot = {
      platform: "kalshi",
      nativeId,
      eventId: null,
      question: "Fictional test fixture?",
      outcomes: [
        { name: "Up", price: 0.4 },
        { name: "Down", price: 0.6 },
      ],
      rulesReference: "https://kalshi.com",
      rulesHash: "fixture",
      closeTime: null,
      fetchedAt: new Date().toISOString(),
      priceAsOf: null,
      nativeUnit: "probability",
      raw: { fixture: true },
    };
    beforeAll(async () => {
      for (const id of [user, foreign])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[user, foreign]]);
      await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    });
    it("owns picks, detects changed idempotency payload and commits one accepted proposal", async () => {
      const input = {
        platform: "kalshi",
        nativeId,
        outcome: "Up",
        reason: "Fixture only",
        requestId: "create",
      };
      const result = (await createPick(
        pool,
        user,
        input,
        async () => snapshot,
      )) as { pickId: string; version: number };
      expect(
        await createPick(pool, user, input, async () => {
          throw new Error("must replay without provider");
        }),
      ).toEqual(result);
      await expect(
        createPick(
          pool,
          user,
          { ...input, reason: "changed" },
          async () => snapshot,
        ),
      ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
      await expect(readPicks(pool, foreign, result.pickId)).rejects.toThrow(
        "NOT_FOUND",
      );
      await expect(
        createPick(
          pool,
          user,
          { ...input, outcome: "YES", requestId: "bad" },
          async () => snapshot,
        ),
      ).rejects.toThrow("OUTCOME_NOT_IN_MARKET");
      const proposal = (await proposePick(pool, user, result.pickId, {
        baseVersion: 1,
        changes: { outcome: "Down" },
        reason: "Reviewed fixture correction",
        requestId: "proposal",
      })) as { proposalId: string };
      const accepted = await Promise.allSettled(
        ["confirm-a", "confirm-b"].map((requestId) =>
          confirmPick(pool, user, result.pickId, {
            proposalId: proposal.proposalId,
            confirmed: true,
            requestId,
          }),
        ),
      );
      expect(accepted.filter((v) => v.status === "fulfilled")).toHaveLength(1);
      const counts = await pool.query(
        "SELECT count(*)::int AS n FROM pick_versions WHERE pick_id=$1",
        [result.pickId],
      );
      expect(counts.rows[0].n).toBe(2);
      const events = await pool.query(
        "SELECT count(*)::int AS n FROM outbox WHERE user_id=$1 AND kind='pick.version.created'",
        [user],
      );
      expect(events.rows[0].n).toBe(2);
    });
    it("records the version at insertion time, after the provider read finishes", async () => {
      const result = (await createPick(
        pool,
        user,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Up",
          reason: "Clock fixture",
          requestId: randomUUID(),
        },
        async () => {
          const row = (
            await pool.query("SELECT clock_timestamp() AS fetched_at")
          ).rows[0];
          return {
            ...snapshot,
            fetchedAt: new Date(row.fetched_at).toISOString(),
          };
        },
      )) as { pickId: string };
      const row = (
        await pool.query(
          "SELECT v.created_at>=s.fetched_at AS ordered FROM pick_versions v JOIN market_snapshots s ON s.id=v.snapshot_id WHERE v.pick_id=$1",
          [result.pickId],
        )
      ).rows[0];
      expect(row.ordered).toBe(true);
    });
    it("rejects a direct late create and confirmation after event start", async () => {
      const input = {
        platform: "kalshi",
        nativeId,
        outcome: "Up",
        reason: "Timing boundary",
        requestId: "late-create",
      };
      await expect(
        createPick(pool, user, input, async () => ({
          ...snapshot,
          raw: { scheduledAt: new Date(Date.now() - 60000).toISOString() },
        })),
      ).rejects.toThrow("EVENT_ALREADY_STARTED");
      const made = (await createPick(
        pool,
        user,
        { ...input, requestId: "timed-create" },
        async () => ({
          ...snapshot,
          raw: { scheduledAt: new Date(Date.now() + 3600000).toISOString() },
        }),
      )) as { pickId: string };
      const p = (await proposePick(pool, user, made.pickId, {
        requestId: "timed-propose",
        baseVersion: 1,
        changes: { outcome: "Down" },
        reason: "Before start",
      })) as { proposalId: string };
      // Test-only clock fixture: production snapshots are never rewritten by this workflow.
      await pool.query(
        "UPDATE market_snapshots SET raw=jsonb_build_object('scheduledAt',$1::text) WHERE id=(SELECT snapshot_id FROM pick_versions WHERE pick_id=$2 AND version=1)",
        [new Date(Date.now() - 60000).toISOString(), made.pickId],
      );
      await expect(
        confirmPick(pool, user, made.pickId, {
          requestId: "late-confirm",
          proposalId: p.proposalId,
          confirmed: true,
        }),
      ).rejects.toThrow("EVENT_ALREADY_STARTED");
      expect((await readPicks(pool, user, made.pickId)).current_version).toBe(
        1,
      );
    });
  },
);
