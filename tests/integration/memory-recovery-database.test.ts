import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  readMemoryInventory,
  canonicalMemory,
} from "../../packages/db/src/memory-recovery";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("owned recovery inventory real DB", () => {
  it("isolates owners, verifies exact receipts, preserves paused authority", async () => {
    const pool = new Pool({ connectionString: url });
    const owner = randomUUID(),
      other = randomUUID(),
      id = randomUUID(),
      op = randomUUID();
    try {
      await pool.query(
        "INSERT INTO users(id,provider_subject) VALUES($1,$1),($2,$2)",
        [owner, other],
      );
      await pool.query("INSERT INTO lessons(id,user_id) VALUES($1,$2)", [
        id,
        owner,
      ]);
      await pool.query(
        `INSERT INTO lesson_versions(lesson_id,user_id,version,rule,scope,approval,status,effective_at) VALUES($1,$2,1,'Recovery fixture','{"domain":"test"}','approved','paused','2026-10-01')`,
        [id, owner],
      );
      const record = {
        logicalId: id,
        type: "lesson",
        version: 1,
        recordedAt: "2026-10-01T00:00:00.000Z",
        payload: {
          id,
          userId: owner,
          version: 1,
          parentVersion: null,
          rule: "Recovery fixture",
          scope: { domain: "test" },
          approval: "approved",
          status: "active",
          effectiveAt: "2026-10-01T00:00:00.000Z",
          expiresAt: null,
          supersededBy: null,
        },
      };
      const receipt = {
        status: "verified",
        hash: createHash("sha256")
          .update(canonicalMemory({ schema: 1, userId: owner, ...record }))
          .digest("hex"),
        blobId: "fixture-not-live",
      };
      await pool.query(
        `INSERT INTO outbox(operation_key,user_id,kind,payload,outcome) VALUES($1,$2,'lesson.version.created',$3,$4)`,
        [
          op,
          owner,
          JSON.stringify({ lessonId: id, version: 1, memoryConsent: true }),
          JSON.stringify({ record, result: receipt }),
        ],
      );
      await pool.query(
        `INSERT INTO memory_records(logical_id,user_id,schema_version,type,payload_hash,sync_status,durable_reference,receipt) VALUES($1,$2,1,'lesson','fixture','verified','fixture-not-live',$3)`,
        [op, owner, JSON.stringify(receipt)],
      );
      expect(
        (await readMemoryInventory(pool, owner)).summary
          .verifiedDistinctLessons,
      ).toBe(1);
      expect((await readMemoryInventory(pool, other)).records).toEqual([]);
      expect(
        (
          await pool.query(
            "SELECT status FROM lesson_versions WHERE lesson_id=$1",
            [id],
          )
        ).rows[0].status,
      ).toBe("paused");
      await pool.query(
        `UPDATE memory_records SET receipt=jsonb_set(receipt,'{hash}','"bad"') WHERE logical_id=$1`,
        [op],
      );
      expect(
        (await readMemoryInventory(pool, owner)).summary
          .verifiedDistinctLessons,
      ).toBe(0);
    } finally {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
      await pool.end();
    }
  });
});
