import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  saveReviewCaseSummary,
  recordReviewCaseFromAssessment,
  listReviewCases,
  persistReviewCaseDebateFromRun,
} from "../../packages/db/src/review-cases";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("review case grouping from persisted impacts", () => {
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
  it("groups three concurrently recorded impacts, dedupes replay, isolates owner", async () => {
    const ids = await Promise.all(
      assessments.map((id) => recordReviewCaseFromAssessment(pool, owner, id)),
    );
    expect(new Set(ids).size).toBe(1);
    await recordReviewCaseFromAssessment(pool, owner, assessments[0]!);
    const result = await listReviewCases(pool, owner);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.picks).toHaveLength(3);
    expect(result.items[0]!.missingChecks).toContain(
      "Dissent has not been assessed",
    );
    expect(
      await recordReviewCaseFromAssessment(pool, other, assessments[0]!),
    ).toBeNull();
    expect((await listReviewCases(pool, other)).items).toEqual([]);
  });
  it("fences summary revisions and rejects fabricated evidence", async () => {
    const rc = (await listReviewCases(pool, owner)).items[0]!;
    const empty = {
      summary: "Another check is needed",
      supportingEvidenceIds: [],
      opposingEvidenceIds: [],
      missingChecks: ["Dissent has not been assessed"],
      dissent: [],
      strongestObjectionId: null,
    };
    await expect(
      saveReviewCaseSummary(pool, owner, rc.id, rc.revision, {
        ...empty,
        supportingEvidenceIds: ["fabricated"],
      }),
    ).rejects.toThrow("UNFROZEN_EVIDENCE");
    await saveReviewCaseSummary(pool, owner, rc.id, rc.revision, empty);
    await expect(
      saveReviewCaseSummary(pool, owner, rc.id, rc.revision, empty),
    ).rejects.toThrow("STALE_CASE");
  });
  it("replaces linked assessment once and rejects superseded assessment replay", async () => {
    const before = (await listReviewCases(pool, owner)).items[0]!;
    const next = randomUUID();
    await pool.query(
      "INSERT INTO pick_impact_assessments(id,user_id,change_id,reason_id,reason_revision,pick_id,pick_version,rules_version,state,payload,checked_at) SELECT $2,user_id,change_id,reason_id,reason_revision,pick_id,pick_version,'corrected-fixture',state,payload,clock_timestamp() FROM pick_impact_assessments WHERE id=$1",
      [assessments[0]!, next],
    );
    expect(await recordReviewCaseFromAssessment(pool, owner, next)).toBe(
      before.id,
    );
    expect(
      await recordReviewCaseFromAssessment(pool, owner, assessments[0]!),
    ).toBeNull();
    const after = (await listReviewCases(pool, owner)).items[0]!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.picks.some((p) => p.assessmentId === next)).toBe(true);
  });
  it("persists frozen opposition from a completed answer without losing dissent", async () => {
    await pool.query(
      "INSERT INTO action_memory_preferences(user_id,memory_consent) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET memory_consent=true",
      [owner],
    );
    const rc = (await listReviewCases(pool, owner)).items[0]!;
    const link = rc.picks[0]!;
    const session = randomUUID(),
      run = randomUUID();
    await pool.query(
      "INSERT INTO conversations(id,user_id,platform,native_id) VALUES($1,$2,'kalshi',$3)",
      [session, owner, market],
    );
    const result = {
      pick: { id: link.pickId, version: link.pickVersion },
      learningEvidence: [
        {
          id: "counter",
          text: "Official contrary evidence",
          retrievedAt: "2026-11-03T00:00:00Z",
        },
      ],
      evidenceDebate: {
        status: "complete",
        calls: 3,
        independentOrigins: 2,
        failures: [],
        sides: {
          opposition: {
            claims: [
              {
                text: "The source contradicts this reason",
                assumption: "Same event",
                falsifier: "Corrected report",
                evidenceIds: ["counter"],
              },
            ],
          },
        },
        result: {
          disposition: "review",
          strongestObjection: {
            dissentId: "opposition:1",
            explanation: "It contradicts the recorded reason",
            evidenceIds: ["counter"],
          },
          supportingIds: [],
          opposingIds: ["counter"],
          missingChecks: [],
          explanation: "Review the contrary evidence",
        },
      },
    };
    await pool.query(
      "INSERT INTO agent_runs(id,user_id,request_id,payload_hash,provider,message,status,result,conversation_id) VALUES($1,$2,$3,'fixture','public','Review','completed',$4,$5)",
      [run, owner, randomUUID(), JSON.stringify(result), session],
    );
    const saved = await persistReviewCaseDebateFromRun(
      pool,
      owner,
      link.assessmentId!,
      run,
    );
    expect(
      (
        await persistReviewCaseDebateFromRun(
          pool,
          owner,
          link.assessmentId!,
          run,
        )
      )?.revision,
    ).toBe(saved?.revision);
    await pool.query(
      "UPDATE action_memory_preferences SET memory_consent=false WHERE user_id=$1",
      [owner],
    );
    await expect(
      persistReviewCaseDebateFromRun(pool, owner, link.assessmentId!, run),
    ).rejects.toThrow("DEBATE_REVIEW_NO_LONGER_ELIGIBLE");
    expect(saved?.strongestObjectionId).toBe("opposition:1");
    expect(saved?.strongestObjectionExplanation).toContain("recorded reason");
    expect(saved?.dissent[0]?.evidenceIds).toEqual(["counter"]);
    expect(saved?.debateProof?.evidence[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await persistReviewCaseDebateFromRun(
        pool,
        other,
        link.assessmentId!,
        run,
      ),
    ).toBeNull();
  });
  it("does not re-open stopped scope", async () => {
    await pool.query("UPDATE source_watches SET state='paused' WHERE id=$1", [
      watch,
    ]);
    expect(
      await recordReviewCaseFromAssessment(pool, owner, assessments[0]!),
    ).toBeNull();
  });
});
