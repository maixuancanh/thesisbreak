import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createApprovedLesson,
  listLessons,
  updateReviewedLesson,
} from "../../packages/db/src/lessons";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "reviewed lesson persistence (isolated PostgreSQL)",
  () => {
    const pool = new Pool({ connectionString: url }),
      user = randomUUID(),
      other = randomUUID();
    beforeAll(async () => {
      for (const id of [user, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[user, other]]);
      await pool.end();
    });
    it("creates once, queues only consented versions, keeps scopes and owners separate", async () => {
      const input = {
        requestId: randomUUID(),
        rule: "Wait for the official lineup",
        scope: { domain: "Sports", competition: "NBA" },
        confirmed: true,
        memoryConsent: true,
      };
      const result = await createApprovedLesson(pool, user, input);
      expect(await createApprovedLesson(pool, user, input)).toEqual(result);
      await expect(
        createApprovedLesson(pool, user, { ...input, rule: "changed" }),
      ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
      expect(await listLessons(pool, other)).toEqual([]);
      const row = (await listLessons(pool, user))[0]!;
      expect(row.lesson.scope).toEqual(input.scope);
      expect(row.sync.state).toBe("pending");
      const event = (
        await pool.query(
          "SELECT payload FROM outbox WHERE user_id=$1 AND payload->>'lessonId'=$2",
          [user, result.lessonId],
        )
      ).rows;
      expect(event).toHaveLength(1);
      expect(event[0].payload.memoryConsent).toBe(true);
      const pause = {
        requestId: randomUUID(),
        baseVersion: 1,
        action: "paused",
        confirmed: true,
      };
      await expect(
        updateReviewedLesson(pool, other, result.lessonId, pause),
      ).rejects.toThrow("NOT_FOUND");
      expect(
        (await updateReviewedLesson(pool, user, result.lessonId, pause))
          .version,
      ).toBe(2);
      expect(
        (await updateReviewedLesson(pool, user, result.lessonId, pause))
          .version,
      ).toBe(2);
      expect((await listLessons(pool, user))[0]!.lesson.status).toBe("paused");
      expect(
        (
          await pool.query(
            "SELECT payload FROM outbox WHERE user_id=$1 AND payload->>'version'='2'",
            [user],
          )
        ).rows[0].payload.memoryConsent,
      ).toBeUndefined();
      const resume = {
        requestId: randomUUID(),
        baseVersion: 2,
        action: "active",
        confirmed: true,
        memoryConsent: true,
      };
      expect(
        (await updateReviewedLesson(pool, user, result.lessonId, resume))
          .version,
      ).toBe(3);
      const resumed = (await listLessons(pool, user))[0]!;
      expect(resumed.lesson.status).toBe("active");
      expect(resumed.sync.state).toBe("pending");
      expect(
        (
          await pool.query(
            "SELECT payload FROM outbox WHERE user_id=$1 AND payload->>'lessonId'=$2 AND payload->>'version'='3'",
            [user, result.lessonId],
          )
        ).rows[0].payload.memoryConsent,
      ).toBe(true);
      await updateReviewedLesson(pool, user, result.lessonId, {
        requestId: randomUUID(),
        baseVersion: 3,
        action: "retired",
        confirmed: true,
      });
      await expect(
        updateReviewedLesson(pool, user, result.lessonId, {
          ...resume,
          baseVersion: 4,
          requestId: randomUUID(),
        }),
      ).rejects.toThrow("LESSON_RETIRED");
    });
  },
);
