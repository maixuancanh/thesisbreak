import { it, expect, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
import { lookupIdentity } from "../../apps/web/lib/server/auth";
it.skipIf(!process.env.TEST_DATABASE_URL)(
  "rejects revoked, expired and unknown database sessions",
  async () => {
    const original = { ...process.env };
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const id = randomUUID();
    const sid = randomUUID();
    try {
      Object.assign(process.env, {
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        APP_URL: "http://localhost:3000",
        AUTH_GOOGLE_ID: "test",
        AUTH_GOOGLE_SECRET: "test",
        AUTH_SECRET: "test-only".repeat(8),
      });
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$2)", [
        id,
        `google:test-${id}`,
      ]);
      await pool.query(
        "INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '1 hour')",
        [randomUUID(), id, createHash("sha256").update(sid).digest("hex")],
      );
      expect(await lookupIdentity(id, sid)).toEqual({ id });
      expect(await lookupIdentity("other-user", sid)).toBeNull();
      await pool.query(
        "UPDATE sessions SET revoked_at=NOW() WHERE user_id=$1",
        [id],
      );
      expect(await lookupIdentity(id, sid)).toBeNull();
      await pool.query(
        "UPDATE sessions SET revoked_at=NULL,expires_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",
        [id],
      );
      expect(await lookupIdentity(id, sid)).toBeNull();
    } finally {
      await pool.query("DELETE FROM users WHERE id=$1", [id]);
      await pool.end();
      process.env = original;
    }
  },
);
