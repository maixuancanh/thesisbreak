import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readWeeklyReview } from "../../packages/db/src/weekly-review";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("weekly account review (isolated PostgreSQL)", () => {
  const pool = new Pool({ connectionString: url }),
    user = randomUUID(),
    other = randomUUID(),
    market = `REVIEW-${randomUUID()}`,
    conversation = randomUUID();
  beforeAll(async () => {
    for (const id of [user, other])
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        id,
      ]);
    await pool.query(
      "INSERT INTO markets(platform,native_id) VALUES('kalshi',$1)",
      [market],
    );
    await pool.query(
      "INSERT INTO conversations(id,user_id,platform,native_id) VALUES($1,$2,'kalshi',$3)",
      [conversation, user, market],
    );
    for (const days of [0, 10])
      await pool.query(
        "INSERT INTO agent_runs(id,user_id,conversation_id,request_id,payload_hash,provider,message,status,result,created_at) VALUES($1,$2,$3,$4,'fixture','public','fixture','completed',$5,now()-($6*interval '1 day'))",
        [
          randomUUID(),
          user,
          conversation,
          randomUUID(),
          JSON.stringify({
            usedLessons: [
              { id: "l", rule: "Wait for official evidence", version: 1 },
            ],
          }),
          days,
        ],
      );
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [[user, other]]);
    await pool.query("DELETE FROM markets WHERE native_id=$1", [market]);
    await pool.end();
  });
  it("counts actual recent runs and preference use without fabricating results", async () => {
    const summary = await readWeeklyReview(pool, user);
    expect(summary.conversationsReviewed).toBe(1);
    expect(summary.preferenceUses).toBe(1);
    expect(summary.usedPreferences[0]?.rule).toBe("Wait for official evidence");
    const foreign = await readWeeklyReview(pool, other);
    expect(foreign.conversationsReviewed).toBe(0);
    expect(foreign.usedPreferences).toEqual([]);
  });
});
