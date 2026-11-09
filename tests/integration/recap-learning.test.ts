import { Pool } from "pg";
import { beforeAll, afterAll } from "vitest";
import { createPick } from "../../packages/db/src/picks";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import {
  recordActionSettlement,
  setActionMemoryConsent,
} from "../../packages/db/src/action-history";
import { prepareDecisionRecap } from "../../packages/db/src/decision-recaps";
import { runOneLearningJob } from "../../packages/integrations/src/learning-worker";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractExperienceCandidates } from "../../packages/agent/src/experience-extractor";
import { learningEvidenceSummary } from "../../packages/domain/src/learning-evidence";
const text =
  '{"conditionOccurred":true,"pickWon":true,"evidenceRefs":["official:1"],"sampleCount":1}';
const atom = {
  id: randomUUID(),
  origin: "verified_outcome" as const,
  reference: "recap:r1:2",
  version: 2,
  hash: createHash("sha256").update(text).digest("hex"),
  text,
  eventId: "event1",
  publishedAt: null,
  occurredAt: "2026-11-02T10:00:00Z",
  retrievedAt: "2026-11-02T10:01:00Z",
  sourceOrigin: "unknown:recap:p1",
};
const experienceId = randomUUID(),
  scope = { domain: "Sports", eventId: "event1" };
const experience = {
  requestId: randomUUID(),
  sessionId: randomUUID(),
  runId: randomUUID(),
  eventId: "event1",
  modelVersion: "m",
  promptVersion: "p",
  prerequisites: ["decision_recap", "single_event_observational"],
  outcome: "Observational only",
  atoms: [atom],
};
const input = {
  userId: "owner",
  experienceId,
  scope,
  experience,
  knownAt: new Date("2026-11-02T12:00:00Z"),
};
const candidate = {
  requestId: randomUUID(),
  kind: "source_observation",
  scope,
  statement:
    "For this event the condition occurred despite the winning pick; the sample remains uncertain.",
  experienceIds: [experienceId],
  evidence: [
    {
      atomId: atom.id,
      version: 2,
      hash: atom.hash,
      stance: "support",
      quote: '"conditionOccurred":true',
    },
  ],
  modelVersion: "m",
  promptVersion: "experience-candidate-v1",
  condition: null,
};
describe("verified recap into existing learning extraction", () => {
  it("keeps at most one grounded candidate and the single-event denominator", async () => {
    const result = await extractExperienceCandidates(input, async (request) => {
      expect(request.system).toContain("Winning is not proof");
      expect(request.prompt).toContain("recap:r1:2");
      return {
        candidates: [candidate, { ...candidate, requestId: randomUUID() }],
      };
    });
    expect(result.status).toBe("extracted");
    expect(result.candidates).toHaveLength(1);
    expect(learningEvidenceSummary([atom])).toMatchObject({
      distinctEventCount: 1,
      independentOriginCount: 0,
    });
  });
  it("rejects invented quotes and wrong event scope", async () => {
    expect(
      (
        await extractExperienceCandidates(input, async () => ({
          candidates: [
            {
              ...candidate,
              evidence: [
                { ...candidate.evidence[0], quote: "Source is always wrong" },
              ],
            },
          ],
        }))
      ).error,
    ).toBe("UNGROUNDED_QUOTE");
    expect(
      (
        await extractExperienceCandidates(input, async () => ({
          candidates: [{ ...candidate, scope: { ...scope, eventId: "other" } }],
        }))
      ).error,
    ).toBe("CANDIDATE_SCOPE_MISMATCH");
  });
  it("excludes post-cutoff recap bytes from model context", async () => {
    let called = false;
    const result = await extractExperienceCandidates(
      { ...input, knownAt: new Date("2026-11-01T12:00:00Z") },
      async () => {
        called = true;
        return { candidates: [] };
      },
    );
    expect(called).toBe(false);
    expect(result.candidates).toEqual([]);
  });
});

// Controlled fixture in a dedicated database; this is no live-event acceptance claim.
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "retained recap capture and correction invalidation",
  () => {
    const owner = randomUUID(),
      nativeId = "RECAP-LEARN-" + randomUUID();
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    let pickId = "",
      runId = "",
      sessionId = "";
    beforeAll(async () => {
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        owner,
      ]);
      const scheduledAt = new Date(Date.now() + 2500).toISOString();
      const pick = await createPick(
        pool,
        owner,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "Expected starter",
          requestId: randomUUID(),
        },
        async () => ({
          platform: "kalshi",
          nativeId,
          eventId: null,
          question: "Controlled learning fixture",
          outcomes: [
            { name: "Yes", price: 0.5 },
            { name: "No", price: 0.5 },
          ],
          rulesReference: "https://kalshi.com",
          rulesHash: "fixture",
          closeTime: null,
          fetchedAt: new Date().toISOString(),
          priceAsOf: null,
          nativeUnit: "probability",
          raw: { scheduledAt },
        }),
      );
      pickId = (pick as { pickId: string }).pickId;
      const run = await claimRun(pool, owner, {
        platform: "kalshi",
        nativeId,
        provider: "public",
        message: "Check the official lineup for this event",
        requestId: randomUUID(),
      });
      runId = run.id;
      sessionId = run.conversationId;
      await pool.query(
        "UPDATE conversations SET memory_consent=false WHERE id=$1 AND user_id=$2",
        [sessionId, owner],
      );
      await finishRun(
        pool,
        owner,
        runId,
        { learningEvidence: [] },
        "completed",
      );
      await pool.query(
        "UPDATE conversations SET memory_consent=true WHERE id=$1 AND user_id=$2",
        [sessionId, owner],
      );
      await setActionMemoryConsent(pool, owner, true);
      await new Promise((resolve) => setTimeout(resolve, 2600));
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=$1", [owner]);
      await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    });
    it("captures exact owner recap bytes then withdraws the old atom on result correction", async () => {
      await recordActionSettlement(pool, pickId, {
        winner: "Yes",
        status: "final",
        rulesHash: "fixture",
        sourceUrl: "https://kalshi.com",
        retrievedAt: new Date(Date.now() - 50).toISOString(),
      });
      const recap = await prepareDecisionRecap(pool, owner, pickId);
      expect(recap.officialResult.status).toBe("final");
      expect(await runOneLearningJob(pool, {}, undefined, owner)).toMatchObject(
        { checked: 1, completed: 1 },
      );
      const rows = (
        await pool.query(
          "SELECT payload,withdrawn_at FROM memory_atoms WHERE user_id=$1 AND payload->>'reference'=$2",
          [owner, `recap:${recap.id}:${recap.revision}`],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.text).toBe(
        JSON.stringify(
          (
            await pool.query(
              "SELECT payload FROM decision_recap_versions WHERE id=$1",
              [recap.id],
            )
          ).rows[0].payload,
        ),
      );
      await recordActionSettlement(pool, pickId, {
        winner: "No",
        status: "final",
        rulesHash: "fixture",
        sourceUrl: "https://kalshi.com",
        retrievedAt: new Date(Date.now() - 50).toISOString(),
      });
      const correction = await prepareDecisionRecap(pool, owner, pickId);
      expect(correction.officialResult.pickWon).toBe(false);
      expect(
        (
          await pool.query(
            "SELECT withdrawn_at FROM memory_atoms WHERE user_id=$1 AND payload->>'reference'=$2",
            [owner, `recap:${recap.id}:${recap.revision}`],
          )
        ).rows[0].withdrawn_at,
      ).not.toBeNull();
      await setActionMemoryConsent(pool, owner, false);
      // Remove unrelated extraction fixture work so the next bounded worker tests the queued correction capture.
      await pool.query(
        "UPDATE learning_jobs SET state='completed' WHERE user_id=$1 AND kind='extract'",
        [owner],
      );
      await runOneLearningJob(pool, {}, undefined, owner);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM memory_atoms WHERE user_id=$1 AND payload->>'reference'=$2",
            [owner, `recap:${correction.id}:${correction.revision}`],
          )
        ).rows[0].n,
      ).toBe(0);
    });
  },
);
