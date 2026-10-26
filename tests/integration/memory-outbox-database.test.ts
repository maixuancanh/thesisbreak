import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  claimMemoryOutbox,
  finishMemoryOutbox,
} from "../../packages/db/src/memory-outbox";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "memory outbox (isolated migrated TEST_DATABASE_URL)",
  () => {
    const pool = new Pool({ connectionString: url });
    const user = randomUUID(),
      id = randomUUID(),
      key = JSON.stringify(["lesson", id, 1]);
    beforeAll(async () => {
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        user,
      ]);
      await pool.query("INSERT INTO lessons(id,user_id) VALUES($1,$2)", [
        id,
        user,
      ]);
      await pool.query(
        `INSERT INTO lesson_versions(lesson_id,user_id,version,rule,scope,approval,status,effective_at) VALUES($1,$2,1,'Fixture rule','{"domain":"test"}','approved','active',now())`,
        [id, user],
      );
      await pool.query(
        `INSERT INTO outbox(operation_key,user_id,kind,payload) VALUES($1,$2,'lesson.version.created',$3),($4,$2,'pick.version.created','{}')`,
        [
          key,
          user,
          JSON.stringify({ lessonId: id, version: 1, memoryConsent: true }),
          key + ":pick",
        ],
      );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM outbox WHERE user_id=$1", [user]);
      await pool.query("DELETE FROM users WHERE id=$1", [user]);
      await pool.end();
    });
    it("skips stale and malformed consented events before claiming valid work", async () => {
      await pool.query(
        `INSERT INTO outbox(operation_key,user_id,kind,payload,created_at) VALUES($1,$2,'lesson.version.created',$3,now()-interval '2 day'),($4,$2,'lesson.version.created',$5,now()-interval '1 day')`,
        [
          key + ":stale",
          user,
          JSON.stringify({
            lessonId: randomUUID(),
            version: 1,
            memoryConsent: true,
          }),
          key + ":malformed",
          JSON.stringify({
            lessonId: { bad: true },
            version: "invalid",
            memoryConsent: true,
          }),
        ],
      );
      const claim = await claimMemoryOutbox(pool);
      expect(claim?.operationKey).toBe(key);
      expect(
        (
          await pool.query(
            "SELECT state FROM outbox WHERE operation_key=ANY($1) ORDER BY operation_key",
            [[key + ":stale", key + ":malformed"]],
          )
        ).rows,
      ).toEqual([{ state: "blocked" }, { state: "blocked" }]);
      await pool.query(
        "UPDATE outbox SET state='pending',attempts=0,lease_until=NULL WHERE operation_key=$1",
        [key],
      );
    });
    it("reclaims expired leases and fences stale completions", async () => {
      const first = await claimMemoryOutbox(pool, 1000);
      expect(first?.operationKey).toBe(key);
      expect(first?.record.logicalId).toBe(id);
      expect(await claimMemoryOutbox(pool)).toBeNull();
      await pool.query(
        "UPDATE outbox SET lease_until=now()-interval '1 second' WHERE operation_key=$1",
        [key],
      );
      const second = await claimMemoryOutbox(pool);
      expect(second?.record).toEqual(first?.record);
      expect(second?.attempt).toBe(2);
      const receipt = {
        status: "verified" as const,
        hash: "a".repeat(64),
        blobId: "fixture",
      };
      expect(await finishMemoryOutbox(pool, first!, receipt)).toBe(false);
      expect(await finishMemoryOutbox(pool, second!, receipt)).toBe(true);
      const rows = await pool.query(
        "SELECT sync_status,durable_reference FROM memory_records WHERE logical_id=$1 AND user_id=$2",
        [key, user],
      );
      expect(rows.rows).toEqual([
        { sync_status: "verified", durable_reference: "fixture" },
      ]);
      expect(
        (
          await pool.query("SELECT state FROM outbox WHERE operation_key=$1", [
            key + ":pick",
          ])
        ).rows[0].state,
      ).toBe("pending");
    });
  },
);
