import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  commitPickVersion,
  commitWatchPlanVersion,
  commitLessonVersion,
} from "../../packages/db/src/versioning";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "PostgreSQL optimistic versioning (requires migrated TEST_DATABASE_URL)",
  () => {
    const pool = new Pool({ connectionString: url });
    const userId = randomUUID();
    const pickId = randomUUID();
    beforeAll(async () => {
      await pool.query(
        "INSERT INTO users(id, provider_subject) VALUES ($1,$2)",
        [userId, userId],
      );
      await pool.query(
        "INSERT INTO markets(platform,native_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        ["kalshi", "integration-versioning"],
      );
      await pool.query(
        "INSERT INTO picks(id,user_id,platform,native_id,current_version) VALUES ($1,$2,$3,$4,1)",
        [pickId, userId, "kalshi", "integration-versioning"],
      );
      await pool.query(
        "INSERT INTO pick_versions(pick_id,user_id,version,parent_version,outcome,assumptions) VALUES ($1,$2,1,NULL,$3,$4)",
        [pickId, userId, "NO", JSON.stringify([])],
      );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=$1", [userId]);
      await pool.end();
    });
    it("commits one competing version and replays exactly the same request result", async () => {
      const input = {
        userId,
        pickId,
        baseVersion: 1,
        changes: { outcome: "YES", reason: "Official evidence" },
        requestId: "request-a",
      };
      const results = await Promise.allSettled([
        commitPickVersion(pool, input),
        commitPickVersion(pool, { ...input, requestId: "request-b" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((r) => r.status === "rejected");
      expect(failed?.status === "rejected" && failed.reason.status).toBe(409);
      const winner =
        results[0]?.status === "fulfilled" ? "request-a" : "request-b";
      expect(
        await commitPickVersion(pool, { ...input, requestId: winner }),
      ).toMatchObject({ version: 2 });
      expect(
        (
          await pool.query("SELECT * FROM pick_versions WHERE pick_id=$1", [
            pickId,
          ])
        ).rowCount,
      ).toBe(2);
      expect(
        (await pool.query("SELECT * FROM outbox WHERE user_id=$1", [userId]))
          .rowCount,
      ).toBe(1);
      await expect(
        commitPickVersion(pool, {
          ...input,
          requestId: winner,
          changes: { outcome: "NO" },
        }),
      ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    });
  },
);

describe.skipIf(!url)("Plan and lesson transaction boundaries", () => {
  const pool = new Pool({ connectionString: url });
  const userId = randomUUID();
  const pickA = randomUUID();
  const pickB = randomUUID();
  const planId = randomUUID();
  const lessonId = randomUUID();
  const nextPlan = {
    pickId: pickA,
    pickVersion: 1,
    condition: { kind: "lineup_changed" as const, assumptionId: "captain" },
    sourceIds: ["official"],
    procedureVersion: "1",
    deadline: "2099-01-02T00:00:00Z",
    timezone: "UTC",
    channel: "in_app" as const,
    approvedAt: "2026-10-22T00:00:00Z",
    state: "active" as const,
  };
  const nextLesson = {
    rule: "Check official team news",
    scope: { domain: "football" },
    approval: "approved" as const,
    status: "active" as const,
    effectiveAt: "2026-10-22T00:00:00Z",
    expiresAt: null,
    supersededBy: null,
  };
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
      userId,
    ]);
    await pool.query(
      "INSERT INTO markets(platform,native_id) VALUES('kalshi','plan-integration') ON CONFLICT DO NOTHING",
    );
    for (const id of [pickA, pickB]) {
      await pool.query(
        "INSERT INTO picks(id,user_id,platform,native_id) VALUES($1,$2,'kalshi','plan-integration')",
        [id, userId],
      );
      await pool.query(
        "INSERT INTO pick_versions(pick_id,user_id,version,outcome) VALUES($1,$2,1,'NO')",
        [id, userId],
      );
    }
    await pool.query(
      "INSERT INTO watch_plans(id,user_id,pick_id) VALUES($1,$2,$3)",
      [planId, userId, pickA],
    );
    await pool.query(
      "INSERT INTO watch_plan_versions(plan_id,user_id,version,pick_id,pick_version,condition,source_ids,procedure_version,deadline,timezone,channel,approved_at,state) VALUES($1,$2,1,$3,1,$4,$5,'1','2099-01-02','UTC','in_app','2026-10-22','active')",
      [
        planId,
        userId,
        pickA,
        JSON.stringify(nextPlan.condition),
        JSON.stringify(nextPlan.sourceIds),
      ],
    );
    await pool.query("INSERT INTO lessons(id,user_id) VALUES($1,$2)", [
      lessonId,
      userId,
    ]);
    await pool.query(
      "INSERT INTO lesson_versions(lesson_id,user_id,version,rule,scope,approval,status,effective_at) VALUES($1,$2,1,$3,$4,'approved','active','2026-10-22')",
      [lessonId, userId, nextLesson.rule, JSON.stringify(nextLesson.scope)],
    );
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await pool.end();
  });
  it("database rejects attaching pick B to the plan for pick A", async () => {
    await expect(
      pool.query(
        "INSERT INTO watch_plan_versions(plan_id,user_id,version,parent_version,pick_id,pick_version,condition,source_ids,procedure_version,deadline,timezone,channel,state) VALUES($1,$2,2,1,$3,1,'{}','[]','1','2099-01-02','UTC','in_app','draft')",
        [planId, userId, pickB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("plan commits only one contender and retries without duplicate version or outbox", async () => {
    const input = {
      userId,
      planId,
      baseVersion: 1,
      requestId: "plan-a",
      next: nextPlan,
    };
    const results = await Promise.allSettled([
      commitWatchPlanVersion(pool, input),
      commitWatchPlanVersion(pool, { ...input, requestId: "plan-b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    const winner = results[0]?.status === "fulfilled" ? "plan-a" : "plan-b";
    expect(
      await commitWatchPlanVersion(pool, { ...input, requestId: winner }),
    ).toMatchObject({ planId, version: 2 });
    expect(
      (
        await pool.query("SELECT * FROM watch_plan_versions WHERE plan_id=$1", [
          planId,
        ])
      ).rowCount,
    ).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT * FROM outbox WHERE user_id=$1 AND kind='watch_plan.version.created'",
          [userId],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      commitWatchPlanVersion(pool, {
        ...input,
        requestId: winner,
        next: { ...nextPlan, state: "paused" },
      }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
  });
  it("lesson commits only one contender and isolates owner and idempotency", async () => {
    const input = {
      userId,
      lessonId,
      baseVersion: 1,
      requestId: "lesson-a",
      next: nextLesson,
    };
    const results = await Promise.allSettled([
      commitLessonVersion(pool, input),
      commitLessonVersion(pool, { ...input, requestId: "lesson-b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    const winner = results[0]?.status === "fulfilled" ? "lesson-a" : "lesson-b";
    expect(
      await commitLessonVersion(pool, { ...input, requestId: winner }),
    ).toMatchObject({ lessonId, version: 2 });
    expect(
      (
        await pool.query("SELECT * FROM lesson_versions WHERE lesson_id=$1", [
          lessonId,
        ])
      ).rowCount,
    ).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT * FROM outbox WHERE user_id=$1 AND kind='lesson.version.created'",
          [userId],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      commitLessonVersion(pool, {
        ...input,
        requestId: winner,
        next: { ...nextLesson, rule: "different" },
      }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await expect(
      commitLessonVersion(pool, {
        ...input,
        userId: "foreign",
        baseVersion: 2,
        requestId: "foreign-request",
      }),
    ).rejects.toThrow("NOT_FOUND");
  });
});
