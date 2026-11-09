import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createApprovedLesson,
  listLessons,
  updateReviewedLesson,
} from "../../packages/db/src/lessons";
import { commitLessonVersion } from "../../packages/db/src/versioning";
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
    it("keeps a reviewed edit immutable without inheriting the previous automatic check", async () => {
      const created = await createApprovedLesson(pool, user, {
        requestId: randomUUID(),
        rule: "Require current official lineup",
        scope: {
          domain: "Sports",
          competition: "NBA",
          sourceClass: "official",
        },
        confirmed: true,
        memoryConsent: true,
      });
      const original = (await listLessons(pool, user)).find(
        (r) => r.lesson.id === created.lessonId,
      )!.lesson;
      const {
        id: _id,
        userId: _owner,
        version: _version,
        parentVersion: _parent,
        ...next
      } = original;
      void _id;
      void _owner;
      void _version;
      void _parent;
      const learningScope = {
        domain: "Sports",
        competition: "NBA",
        eventId: "test-event",
      };
      const learningCondition = {
        type: "require_official_lineup" as const,
        expiresAt: "2030-01-01T00:00:00Z",
      };
      await commitLessonVersion(pool, {
        userId: user,
        lessonId: created.lessonId,
        baseVersion: 1,
        requestId: randomUUID(),
        memoryConsent: true,
        next: { ...next, learningScope, learningCondition },
      });
      const edit = {
        requestId: randomUUID(),
        baseVersion: 2,
        action: "edit",
        rule: "Compare my saved quote instead",
        scope: original.scope,
        confirmed: true,
        memoryConsent: true,
      };
      expect(
        await updateReviewedLesson(pool, user, created.lessonId, edit),
      ).toEqual({ lessonId: created.lessonId, version: 3 });
      expect(
        await updateReviewedLesson(pool, user, created.lessonId, edit),
      ).toEqual({ lessonId: created.lessonId, version: 3 });
      const current = (await listLessons(pool, user)).find(
        (r) => r.lesson.id === created.lessonId,
      )!.lesson;
      expect(current.learningCondition).toBeUndefined();
      expect(current.learningScope).toEqual(learningScope);
      expect(current.scope.sourceClass).toBe("official");
      const history = (
        await pool.query(
          "SELECT version,learning_condition FROM lesson_versions WHERE lesson_id=$1 AND user_id=$2 ORDER BY version",
          [created.lessonId, user],
        )
      ).rows;
      expect(history).toHaveLength(3);
      expect(history[1].learning_condition).toEqual(learningCondition);
      expect(history[2].learning_condition).toBeNull();
    });
  },
);
