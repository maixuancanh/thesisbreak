import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createPick } from "../../packages/db/src/picks";
import { recordActionSettlement } from "../../packages/db/src/action-history";
import {
  prepareDecisionRecap,
  readDecisionRecap,
} from "../../packages/db/src/decision-recaps";
import {
  saveAnswerClaims,
  submitClaimChallenge,
  readClaimChallenge,
  withdrawClaimChallenge,
} from "../../packages/db/src/claim-challenges";
import { runOneClaimChallengeJob } from "../../packages/integrations/src/claim-challenge-worker";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "explanation review does not mutate official outcomes",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID(),
      session = randomUUID(),
      message = randomUUID(),
      nativeId = "EXPLANATION-" + randomUUID();
    let pickId = "";
    beforeAll(async () => {
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        owner,
      ]);
      const saved = await createPick(
        pool,
        owner,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "The lineup is confirmed.",
          requestId: randomUUID(),
        },
        async () => ({
          platform: "kalshi",
          nativeId,
          eventId: null,
          question: "Fixture",
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
          raw: {},
        }),
      );
      pickId = (saved as { pickId: string }).pickId;
      await recordActionSettlement(pool, pickId, {
        winner: "Yes",
        status: "final",
        rulesHash: "fixture",
        sourceUrl: "https://kalshi.com",
        retrievedAt: new Date().toISOString(),
      });
      await prepareDecisionRecap(pool, owner, pickId);
      await pool.query(
        "INSERT INTO conversations(id,user_id,platform,native_id) VALUES($1,$2,'kalshi',$3)",
        [session, owner, nativeId],
      );
      await pool.query(
        "INSERT INTO agent_runs(id,user_id,conversation_id,request_id,payload_hash,provider,message,status,result) VALUES($1,$2,$3,$4,'fixture','public','Question','completed',$5)",
        [
          message,
          owner,
          session,
          randomUUID(),
          JSON.stringify({
            reply: {
              message: "The lineup is confirmed.",
              evidenceRefs: [`action:${pickId}:1`],
            },
          }),
        ],
      );
      await saveAnswerClaims(pool, owner, message, [
        {
          claimId: "lineup",
          claimText: "The lineup is confirmed.",
          evidenceIds: [`action:${pickId}:1`],
        },
      ]);
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=$1", [owner]);
      await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    });
    const submit = () =>
      submitClaimChallenge(pool, owner, {
        messageId: message,
        answerRevision: 1,
        claimId: "lineup",
        explanation: "The current official lineup contradicts that statement.",
        evidenceUrls: ["https://official.example/lineup"],
        clientRequestId: randomUUID(),
      });
    it("appends a verified correction and retains the original forecast, answer and settlement", async () => {
      const before = (await readDecisionRecap(pool, owner, pickId))!;
      const challenge = await submit();
      const opened = (await readDecisionRecap(pool, owner, pickId))!;
      expect(opened.officialResult).toEqual(before.officialResult);
      expect(opened.explanationReview?.status).toBe("under_review");
      await runOneClaimChallengeJob(pool, {
        ownerId: owner,
        hosts: ["official.example"],
        fetchText: async () => ({
          text: "The official lineup is not yet confirmed.",
          contentType: "text/plain",
        }),
        verify: async ({ sources }) => ({
          status: "accepted",
          explanation:
            "The official statement contradicts the certainty of this answer.",
          correctionText:
            "The current official lineup has not yet been confirmed. This correction does not change the original forecast.",
          citations: [{ evidenceId: sources[0]!.id, quote: sources[0]!.text }],
        }),
      });
      const corrected = (await readDecisionRecap(pool, owner, pickId))!;
      expect(corrected.explanationReview?.status).toBe("corrected");
      expect(corrected.officialResult).toEqual(before.officialResult);
      const history = await readClaimChallenge(pool, owner, challenge.id);
      expect(history.status).toBe("accepted");
      expect(history.revisions.at(-1).revision.correctionText).toContain(
        "current official lineup",
      );
      expect(
        (
          await pool.query("SELECT result FROM agent_runs WHERE id=$1", [
            message,
          ])
        ).rows[0].result.reply.message,
      ).toBe("The lineup is confirmed.");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM pick_versions WHERE user_id=$1 AND pick_id=$2",
            [owner, pickId],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("withdrawal during source retrieval fences the pending correction", async () => {
      const challenge = await submit();
      await runOneClaimChallengeJob(pool, {
        ownerId: owner,
        hosts: ["official.example"],
        fetchText: async () => {
          const held = await readClaimChallenge(pool, owner, challenge.id);
          await withdrawClaimChallenge(pool, owner, challenge.id, {
            action: "withdraw",
            expectedRevision: held.current_revision,
          });
          return { text: "Contradiction.", contentType: "text/plain" };
        },
        verify: async ({ sources }) => ({
          status: "accepted",
          explanation: "Direct contradiction.",
          correctionText: "Correction must be discarded after withdrawal.",
          citations: [{ evidenceId: sources[0]!.id, quote: "Contradiction." }],
        }),
      });
      const history = await readClaimChallenge(pool, owner, challenge.id);
      expect(history.status).toBe("withdrawn");
      expect(
        history.revisions.some(
          (r: { revision: { status: string } }) =>
            r.revision.status === "accepted",
        ),
      ).toBe(false);
    });
  },
);
