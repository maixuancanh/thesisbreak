import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPick } from "../../packages/db/src/picks";
import { recordActionSettlement } from "../../packages/db/src/action-history";
import {
  prepareDecisionRecap,
  readDecisionRecap,
} from "../../packages/db/src/decision-recaps";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "owner-bound append-only decision recap",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID(),
      other = randomUUID(),
      nativeId = "RECAP-" + randomUUID();
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
          reason: "Initial reason",
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
          raw: {},
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
    it("records unchanged picks and appends correction without overwriting", async () => {
      const waiting = await prepareDecisionRecap(pool, owner, pickId);
      expect(waiting.officialResult.status).toBe("waiting");
      expect(await readDecisionRecap(pool, other, pickId)).toBeNull();
      await expect(prepareDecisionRecap(pool, other, pickId)).rejects.toThrow(
        "NOT_FOUND",
      );
      await recordActionSettlement(pool, pickId, {
        winner: "Yes",
        status: "final",
        rulesHash: "fixture",
        sourceUrl: "https://kalshi.com",
        retrievedAt: new Date(Date.now() - 1000).toISOString(),
      });
      const final = await prepareDecisionRecap(pool, owner, pickId);
      expect(final.officialResult.status).toBe("not_scored");
      expect(final.officialResult.pickWon).toBeNull();
      expect((await prepareDecisionRecap(pool, owner, pickId)).id).toBe(
        final.id,
      );
      await recordActionSettlement(pool, pickId, {
        winner: "No",
        status: "final",
        rulesHash: "fixture",
        sourceUrl: "https://kalshi.com",
        retrievedAt: new Date(Date.now() - 1000).toISOString(),
      });
      const correction = await prepareDecisionRecap(pool, owner, pickId);
      expect(correction.revision).toBe(final.revision + 1);
      expect(correction.predecessorId).toBe(final.id);
      expect(
        (
          await pool.query(
            "SELECT payload FROM decision_recap_versions WHERE id=$1",
            [final.id],
          )
        ).rows[0].payload.officialResult.winner,
      ).toBe("Yes");
    });
  },
);
