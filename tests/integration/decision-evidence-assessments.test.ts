import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessDecisionEvidence } from "../../packages/agent/src/decision-evidence-assessment";
import { selectDecisionQuoteSnapshots } from "../../packages/agent/src/decision-evidence-assessment";
import { normalizePublicDecisionQuotes } from "../../packages/integrations/src/decision-quote-adapter";
import {
  recordPublicDecisionQuoteSnapshot,
  readRecordedDecisionQuotes,
} from "../../packages/db/src/decision-quote-snapshots";
import { monitoringTransaction } from "../../packages/db/src/pick-reasons";
import {
  saveDecisionEvidenceAssessment,
  readDecisionEvidenceAssessments,
} from "../../packages/db/src/decision-evidence-assessments";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "append-only owner-bound evidence assessments",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const owner = randomUUID(),
      other = randomUUID(),
      caseId = randomUUID(),
      pickId = randomUUID(),
      reasonId = randomUUID(),
      watch = randomUUID(),
      change = randomUUID(),
      market = randomUUID();
    const input = {
      caseId,
      caseRevision: 1,
      pickId,
      pickVersion: 1,
      reasonId,
      reasonVersion: 1,
      assessment: assessDecisionEvidence({
        reasonImpact: "invalidated",
        beforeQuote: null,
        afterQuote: null,
        observedAt: "2026-11-03T12:00:00.000Z",
      }),
    };
    beforeAll(async () => {
      const target = new URL(process.env.TEST_DATABASE_URL!);
      if (
        !["127.0.0.1", "localhost"].includes(target.hostname) ||
        !target.pathname.includes("accountability")
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
        "INSERT INTO picks(id,user_id,platform,native_id) VALUES($1,$2,'kalshi',$3)",
        [pickId, owner, market],
      );
      await pool.query(
        "INSERT INTO pick_versions(pick_id,user_id,version,outcome) VALUES($1,$2,1,'Yes')",
        [pickId, owner],
      );
      await pool.query(
        "INSERT INTO pick_reason_versions(id,user_id,pick_id,pick_version,revision,payload) VALUES($1,$2,$3,1,1,'{}')",
        [reasonId, owner, pickId],
      );
      await pool.query(
        "INSERT INTO source_watches(id,user_id,event_id,url,origin_id,content_class,selector,dependency_id,hypothesis_version,expires_at,poll_seconds) VALUES($1,$2,'event','https://example.com','official','json','/x','dependency',1,clock_timestamp()+interval '1 day',300)",
        [watch, owner],
      );
      await pool.query(
        "INSERT INTO source_change_events(id,watch_id,user_id,before_hash,after_hash,sequence,before_value,after_value) VALUES($1,$2,$3,'a','b',1,'before','after')",
        [change, watch, owner],
      );
      await pool.query(
        "INSERT INTO review_cases(id,user_id,event_id,trigger_evidence_revision_id,reason_dependency_id,payload) VALUES($1,$2,'event',$3,'dependency','{}')",
        [caseId, owner, change],
      );
      await pool.query(
        "INSERT INTO review_case_picks(case_id,user_id,pick_id,pick_version,reason_id,reason_version) VALUES($1,$2,$3,1,$4,1)",
        [caseId, owner, pickId, reasonId],
      );
    });
    afterAll(async () => {
      await pool.query(
        "DELETE FROM decision_evidence_assessments WHERE user_id=$1",
        [owner],
      );
      await pool.query("DELETE FROM review_cases WHERE user_id=$1", [owner]);
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
      await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
        market,
      ]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [market]);
      await pool.end();
    });
    it("uses actual recorded public book snapshots on either side of the trigger", async () => {
      const rules = "Fixture rules";
      for (const [at, bid, ask] of [
        ["2026-11-03T11:59:00Z", "0.4", "0.44"],
        ["2026-11-03T12:01:00Z", "0.5", "0.54"],
      ]) {
        const quotes = normalizePublicDecisionQuotes(
          {
            ticker: market,
            status: "active",
            yes_bid_dollars: bid,
            yes_ask_dollars: ask,
            yes_bid_size_fp: "2",
            yes_ask_size_fp: "3",
            rules_primary: rules,
          },
          "kalshi",
          at!,
        );
        expect(
          await recordPublicDecisionQuoteSnapshot(pool, {
            platform: "kalshi",
            id: market,
            eventId: "event",
            question: "Fixture only",
            outcomes: [
              { name: "Yes", price: 0.9 },
              { name: "No", price: null },
            ],
            rules,
            sourceUrl: "https://external-api.kalshi.com/fixture",
            fetchedAt: at,
            closeTime: null,
            decisionQuotes: quotes,
          }),
        ).toBe(true);
      }
      const triggerObservedAt = "2026-11-03T12:00:00Z",
        now = "2026-11-03T12:02:00Z";
      const quotes = await monitoringTransaction(pool, owner, (c) =>
        readRecordedDecisionQuotes(c, owner, pickId, triggerObservedAt, now),
      );
      expect(quotes).toHaveLength(2);
      expect(
        await monitoringTransaction(pool, other, (c) =>
          readRecordedDecisionQuotes(c, other, pickId, triggerObservedAt, now),
        ),
      ).toEqual([]);
      const result = assessDecisionEvidence({
        reasonImpact: "invalidated",
        ...selectDecisionQuoteSnapshots({ quotes, triggerObservedAt, now }),
        triggerObservedAt,
        observedAt: now,
      });
      expect(result).toMatchObject({
        priceAssessment: "movement_observed",
        needsReview: true,
        adjustedProbability: null,
      });
      expect(result.quoteContext?.before?.probability).toBe(0.42);
      expect(result.quoteContext?.after?.probability).toBe(0.52);
    });
    it("concurrent retries retain one immutable assessment and isolate owner", async () => {
      const results = await Promise.all([
        saveDecisionEvidenceAssessment(pool, owner, input),
        saveDecisionEvidenceAssessment(pool, owner, input),
      ]);
      expect(results[0]!.id).toBe(results[1]!.id);
      expect(
        (await readDecisionEvidenceAssessments(pool, owner, caseId, 1))[0]
          ?.assessment,
      ).toMatchObject({
        needsReview: true,
        priceAssessment: "unknown",
        adjustedProbability: null,
      });
      expect(
        await readDecisionEvidenceAssessments(pool, other, caseId, 1),
      ).toEqual([]);
      await expect(
        saveDecisionEvidenceAssessment(pool, other, input),
      ).rejects.toThrow("STALE_ASSESSMENT_SCOPE");
    });
    it("rejects rewrite and stale revisions", async () => {
      await expect(
        saveDecisionEvidenceAssessment(pool, owner, {
          ...input,
          assessment: { ...input.assessment, reasonImpact: "weakened" },
        }),
      ).rejects.toThrow("ASSESSMENT_REVISION_CONFLICT");
      await expect(
        saveDecisionEvidenceAssessment(pool, owner, {
          ...input,
          caseRevision: 2,
        }),
      ).rejects.toThrow("STALE_ASSESSMENT_SCOPE");
    });
    it("Stop blocks subsequent assessment writes", async () => {
      await pool.query(
        "UPDATE review_case_picks SET disposition='stopped' WHERE case_id=$1",
        [caseId],
      );
      await expect(
        saveDecisionEvidenceAssessment(pool, owner, input),
      ).rejects.toThrow("STALE_ASSESSMENT_SCOPE");
    });
  },
);
