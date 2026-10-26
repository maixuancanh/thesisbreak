import { it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { createApprovedLesson } from "../../packages/db/src/lessons";
it.skipIf(!process.env.TEST_DATABASE_URL)(
  "a suggested lesson has no outbox until owned completed-run review and consent",
  async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID(),
      other = randomUUID(),
      nativeId = `LESSON-${randomUUID().toUpperCase()}`;
    try {
      for (const id of [owner, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
      const run = await claimRun(pool, owner, {
        platform: "kalshi",
        nativeId,
        provider: "public",
        message: "Review result",
        requestId: randomUUID(),
      });
      const payload = {
        requestId: randomUUID(),
        confirmed: true,
        memoryConsent: true,
        rule: "Check official participation evidence before relying on a starting-lineup assumption.",
        scope: { domain: "Sports" },
        sourceRunId: run.id,
      };
      await expect(createApprovedLesson(pool, owner, payload)).rejects.toThrow(
        "NOT_FOUND",
      );
      await finishRun(
        pool,
        owner,
        run.id,
        { reply: { retrospective: { reasoningLesson: payload.rule } } },
        "completed",
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM outbox WHERE user_id=$1",
            [owner],
          )
        ).rows[0].n,
      ).toBe(0);
      await expect(createApprovedLesson(pool, other, payload)).rejects.toThrow(
        "NOT_FOUND",
      );
      await expect(
        createApprovedLesson(pool, owner, { ...payload, memoryConsent: false }),
      ).rejects.toThrow();
      const saved = await createApprovedLesson(pool, owner, payload);
      expect(await createApprovedLesson(pool, owner, payload)).toEqual(saved);
      const row = (
        await pool.query(
          "SELECT originating_correction FROM lesson_versions WHERE lesson_id=$1",
          [saved.lessonId],
        )
      ).rows[0];
      expect(row.originating_correction).toBe(run.id);
      expect(
        (
          await pool.query("SELECT payload FROM outbox WHERE user_id=$1", [
            owner,
          ])
        ).rows,
      ).toHaveLength(1);
    } finally {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    }
  },
);
