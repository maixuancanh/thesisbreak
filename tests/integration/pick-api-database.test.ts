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
  },
);
