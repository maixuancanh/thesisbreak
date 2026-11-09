import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("accountability database owner constraints", () => {
  const pool = new Pool({ connectionString: url });
  const owner = randomUUID(),
    other = randomUUID(),
    session = randomUUID(),
    run = randomUUID();
  beforeAll(async () => {
    const u = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(u.hostname) ||
      !u.pathname.includes("accountability")
    )
      throw Error("DEDICATED_ACCOUNTABILITY_DATABASE_REQUIRED");
    await pool.query(
      "INSERT INTO users(id,provider_subject) VALUES($1,$1),($2,$2)",
      [owner, other],
    );
    await pool.query("INSERT INTO conversations(id,user_id) VALUES($1,$2)", [
      session,
      owner,
    ]);
    await pool.query(
      "INSERT INTO agent_runs(id,user_id,conversation_id,request_id,payload_hash,provider,message,status) VALUES($1,$2,$3,$1,'h','public','test','completed')",
      [run, owner, session],
    );
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
    await pool.end();
  });
  it("rejects crossed owner anchors and preserves immutable claims", async () => {
    const sql =
      "INSERT INTO answer_claims(user_id,session_id,message_id,answer_revision,claim_id,claim_text_hash,claim_text) VALUES($1,$2,$3,1,'claim',$4,'text')";
    await expect(
      pool.query(sql, [other, session, run, "a".repeat(64)]),
    ).rejects.toMatchObject({ code: "23503" });
    await pool.query(sql, [owner, session, run, "a".repeat(64)]);
    await expect(
      pool.query(
        "UPDATE answer_claims SET claim_text='changed' WHERE user_id=$1",
        [owner],
      ),
    ).rejects.toThrow("append-only");
  });
  it("enforces concurrent request dedupe and exact anchored challenge ownership", async () => {
    const insert = (id: string, user: string) =>
      pool.query(
        "INSERT INTO claim_challenges(id,user_id,session_id,message_id,answer_revision,claim_id,client_request_id,request_hash,explanation,evidence_urls,payload) VALUES($1,$2,$3,$4,1,'claim','retry','hash','check','[]','{}') ON CONFLICT(user_id,client_request_id) DO NOTHING RETURNING id",
        [id, user, session, run],
      );
    const r = await Promise.all([
      insert(randomUUID(), owner),
      insert(randomUUID(), owner),
    ]);
    expect(r.reduce((s, x) => s + x.rowCount!, 0)).toBe(1);
    await expect(insert(randomUUID(), other)).rejects.toMatchObject({
      code: "23503",
    });
  });
});
