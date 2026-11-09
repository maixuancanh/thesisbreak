import {
  listReviewFollowups,
  setReviewFollowup,
} from "../../packages/db/src/review-followups";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  recordReviewCaseFromAssessment,
  saveReviewCaseSummary,
  listReviewCases,
} from "../../packages/db/src/review-cases";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("review followup remaining-work inbox", () => {
  const pool = new Pool({ connectionString: url });
  const owner = randomUUID(),
    other = randomUUID(),
    watch = randomUUID(),
    change = randomUUID(),
    market = randomUUID();
  const assessments: string[] = [];
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
    await pool.query(
      "INSERT INTO markets(platform,native_id) VALUES('kalshi',$1)",
      [market],
    );
    await pool.query(
      "INSERT INTO action_memory_preferences(user_id,memory_consent) VALUES($1,true)",
      [owner],
    );
    await pool.query(
      "INSERT INTO source_watches(id,user_id,event_id,url,origin_id,content_class,selector,dependency_id,hypothesis_version,expires_at,poll_seconds) VALUES($1,$2,'event','https://example.com','official','json','/x','same-dependency',1,clock_timestamp()+interval '1 day',300)",
      [watch, owner],
    );
    await pool.query(
      "INSERT INTO source_change_events(id,watch_id,user_id,before_hash,after_hash,sequence,before_value,after_value) VALUES($1,$2,$3,'a','b',1,'before','after')",
      [change, watch, owner],
    );
    for (let n = 0; n < 3; n++) {
      const pick = randomUUID(),
        reason = randomUUID(),
        a = randomUUID();
      assessments.push(a);
      await pool.query(
        "INSERT INTO picks(id,user_id,platform,native_id) VALUES($1,$2,'kalshi',$3)",
        [pick, owner, market],
      );
      await pool.query(
        "INSERT INTO pick_versions(pick_id,user_id,version,outcome) VALUES($1,$2,1,'Yes')",
        [pick, owner],
      );
      await pool.query(
        "INSERT INTO pick_reason_versions(id,user_id,pick_id,pick_version,revision,payload) VALUES($1,$2,$3,1,1,'{}')",
        [reason, owner, pick],
      );
      await pool.query(
        "INSERT INTO pick_watch_bindings(id,user_id,reason_id,watch_id,condition_index) VALUES($1,$2,$3,$4,0)",
        [randomUUID(), owner, reason, watch],
      );
      await pool.query(
        "INSERT INTO pick_impact_assessments(id,user_id,change_id,reason_id,reason_revision,pick_id,pick_version,rules_version,state,payload) VALUES($1,$2,$3,$4,1,$5,1,'fixture','needs_review','{}')",
        [a, owner, change, reason, pick],
      );
    }
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
    await pool.query(
      "DELETE FROM markets WHERE platform='kalshi' AND native_id=$1",
      [market],
    );
    await pool.end();
  });
  it("queues only current unresolved links and rejects stale requests", async () => {
    await Promise.all(
      assessments.map((id) => recordReviewCaseFromAssessment(pool, owner, id)),
    );
    const rows = await listReviewFollowups(pool, owner);
    expect(rows).toHaveLength(3);
    expect(await listReviewFollowups(pool, other)).toEqual([]);
    const f = rows[0]!;
    await expect(
      setReviewFollowup(pool, other, f.id, {
        caseRevision: f.case_revision,
        action: "stop",
      }),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      setReviewFollowup(pool, owner, f.id, {
        caseRevision: f.case_revision - 1,
        action: "acknowledge",
      }),
    ).rejects.toThrow("STALE_REVIEW");
    await setReviewFollowup(pool, owner, f.id, {
      caseRevision: f.case_revision,
      action: "acknowledge",
    });
    const second = rows[1]!;
    await setReviewFollowup(pool, owner, second.id, {
      caseRevision: second.case_revision,
      action: "snooze",
      dueAt: new Date(Date.now() + 3600000).toISOString(),
      timezone: "Asia/Ho_Chi_Minh",
    });
    await expect(
      setReviewFollowup(pool, owner, second.id, {
        caseRevision: second.case_revision,
        action: "snooze",
        dueAt: new Date(Date.now() - 1000).toISOString(),
        timezone: "UTC",
      }),
    ).rejects.toThrow("INVALID_SNOOZE");
    const rc = (await listReviewCases(pool, owner)).items[0]!;
    await saveReviewCaseSummary(pool, owner, rc.id, rc.revision, {
      summary: "Still checking",
      supportingEvidenceIds: [],
      opposingEvidenceIds: [],
      missingChecks: ["Dissent has not been assessed"],
      dissent: [],
      strongestObjectionId: null,
    });
    const carried = (
      await pool.query(
        "SELECT due_at,timezone,state FROM review_followups WHERE user_id=$1 AND pick_id=$2 ORDER BY case_revision DESC LIMIT 1",
        [owner, second.pick_id],
      )
    ).rows[0];
    expect(carried.state).toBe("snoozed");
    expect(carried.timezone).toBe("Asia/Ho_Chi_Minh");
    expect(await listReviewFollowups(pool, owner)).toHaveLength(1);
    await expect(
      setReviewFollowup(pool, owner, second.id, {
        caseRevision: second.case_revision,
        action: "snooze",
        dueAt: new Date(Date.now() - 1000).toISOString(),
        timezone: "UTC",
      }),
    ).rejects.toThrow("STALE_REVIEW");
  });
  it("stop is durable across requeue and does not alter another pick", async () => {
    const row = (await listReviewFollowups(pool, owner))[0]!;
    await setReviewFollowup(pool, owner, row.id, {
      caseRevision: row.case_revision,
      action: "stop",
    });
    await Promise.all(
      assessments.map((id) => recordReviewCaseFromAssessment(pool, owner, id)),
    );
    expect(await listReviewFollowups(pool, owner)).toEqual([]);
    await expect(
      setReviewFollowup(pool, owner, row.id, {
        caseRevision: row.case_revision,
        action: "acknowledge",
      }),
    ).rejects.toThrow("FOLLOWUP_STOPPED");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM pick_watch_bindings WHERE user_id=$1 AND state='active'",
          [owner],
        )
      ).rows[0].n,
    ).toBe(2);
  });
});
