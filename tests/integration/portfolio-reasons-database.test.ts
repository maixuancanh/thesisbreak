import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPick, type Snapshot } from "../../packages/db/src/picks";
import { readPortfolioReasons } from "../../packages/db/src/portfolio-reasons";

describe.skipIf(!process.env.TEST_DATABASE_URL)("portfolio reason owner and version boundaries", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const owner = randomUUID(), other = randomUUID();
  const ids: string[] = [];
  const snapshotIds: string[] = [];
  beforeAll(async () => {
    for (const user of [owner, other]) await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [user]);
    for (const [index, user] of [owner, owner, owner, owner, other].entries()) {
      const snapshot: Snapshot = {
        platform: "kalshi", nativeId: `PORTFOLIO-${owner}-${index}`, eventId: `event-${owner}`,
        question: "Isolated portfolio fixture?", outcomes: [{ name: "Yes", price: 0.5 }, { name: "No", price: 0.5 }],
        rulesReference: "https://example.com/rules", rulesHash: "fixture", closeTime: null,
        fetchedAt: new Date().toISOString(), priceAsOf: null, nativeUnit: "probability", raw: { rules: "Fixture only" },
      };
      const created = await createPick(pool, user, { platform: "kalshi", nativeId: snapshot.nativeId, outcome: "Yes", reason: "Same recorded condition", requestId: randomUUID() }, async () => snapshot) as { pickId: string };
      ids.push(created.pickId);
      const row = await pool.query("SELECT snapshot_id FROM pick_versions WHERE pick_id=$1 AND user_id=$2", [created.pickId, user]);
      snapshotIds.push(row.rows[0].snapshot_id);
    }
    await pool.query("UPDATE picks SET state='paused' WHERE id=$1 AND user_id=$2", [ids[2], owner]);
    await pool.query("UPDATE market_snapshots SET close_time=clock_timestamp()-interval '1 hour' WHERE id=$1", [snapshotIds[3]]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1::text[])", [[owner, other]]);
    await pool.query("DELETE FROM market_snapshots WHERE id=ANY($1::text[])", [snapshotIds]);
    await pool.end();
  });
  it("only current active unclosed owner picks enter groups", async () => {
    const result = await readPortfolioReasons(pool, owner);
    expect(result.checkedPicks).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.picks.map((p) => p.id).sort()).toEqual(ids.slice(0, 2).sort());
    expect((await readPortfolioReasons(pool, other)).groups).toEqual([]);
  });
});
