import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  claimRun,
  finishRun,
  conversationHistory,
} from "../../packages/db/src/agent-runs";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "durable agent runs (requires isolated migrated TEST_DATABASE_URL)",
  () => {
    const pool = new Pool({ connectionString: url });
    const user = randomUUID(),
      other = randomUUID();
    const nativeId = `AGENT-${randomUUID().replaceAll("-", "").toUpperCase()}`;
    beforeAll(async () => {
      for (const id of [user, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[user, other]]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    });
    it("replays once, rejects altered request and hides other user history", async () => {
      const input = {
        platform: "kalshi" as const,
        nativeId,
        provider: "public" as const,
        message: "Fictional test",
        requestId: randomUUID(),
      };
      const run = await claimRun(pool, user, input);
      expect(run.fresh).toBe(true);
      expect((await claimRun(pool, user, input)).fresh).toBe(false);
      await expect(
        claimRun(pool, user, { ...input, message: "altered" }),
      ).rejects.toThrow("REQUEST_ID_REUSED");
      await expect(
        claimRun(pool, user, { ...input, requestId: randomUUID() }),
      ).rejects.toThrow("CONVERSATION_BUSY");
      await finishRun(
        pool,
        user,
        run.id,
        { reply: { message: "fixture" } },
        "completed",
      );
      const replay = await claimRun(pool, user, input);
      expect(replay.status).toBe("completed");
      expect(
        await conversationHistory(pool, other, "kalshi", nativeId),
      ).toEqual([]);
      expect(
        (await conversationHistory(pool, user, "kalshi", nativeId)).length,
      ).toBe(1);
      await expect(
        finishRun(pool, other, run.id, {}, "failed"),
      ).rejects.toThrow("RUN_NO_LONGER_ACTIVE");
    });
  },
);
