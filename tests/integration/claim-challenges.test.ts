import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  saveAnswerClaims,
  submitClaimChallenge,
  readClaimChallenge,
  withdrawClaimChallenge,
} from "../../packages/db/src/claim-challenges";
import { loadCurrentApprovedLessons } from "../../packages/db/src/approved-lessons";
import {
  recordLearningExperience,
  createLessonCandidate,
  reviewLessonCandidate,
} from "../../packages/db/src/experience-learning";
import { claimTextHash } from "../../packages/db/src/claim-challenges";
import { runOneClaimChallengeJob } from "../../packages/integrations/src/claim-challenge-worker";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "owner bound claim correction lifecycle",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID(),
      other = randomUUID(),
      session = randomUUID(),
      message = randomUUID();
    const body = {
      messageId: message,
      answerRevision: 1,
      claimId: "lineup",
      explanation: "This needs the official lineup.",
      evidenceUrls: [],
      clientRequestId: randomUUID(),
    };
    const retrievedAt = new Date().toISOString();
    let lessonId = "";
    beforeAll(async () => {
      for (const id of [owner, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
      await pool.query(
        "INSERT INTO markets(platform,native_id) VALUES('kalshi',$1) ON CONFLICT DO NOTHING",
        ["CHALLENGE-" + message],
      );
      await pool.query(
        "INSERT INTO conversations(id,user_id,platform,native_id) VALUES($1,$2,'kalshi',$3)",
        [session, owner, "CHALLENGE-" + message],
      );
      await pool.query(
        "INSERT INTO agent_runs(id,user_id,request_id,payload_hash,provider,message,status,result,conversation_id) VALUES($1,$2,$3,'fixture','public','Question','completed',$4,$5)",
        [
          message,
          owner,
          randomUUID(),
          JSON.stringify({
            learningEvidence: [
              {
                id: "official-lineup:1",
                text: "Player A starts.",
                retrievedAt,
                sourceOrigin: "official:lineup",
              },
            ],
            reply: {
              message: "Player A starts.",
              evidenceRefs: ["official-lineup:1"],
            },
          }),
          session,
        ],
      );
      await saveAnswerClaims(pool, owner, message, [
        {
          claimId: "lineup",
          claimText: "Player A starts.",
          evidenceIds: ["official-lineup:1"],
        },
      ]);
      await pool.query(
        "UPDATE conversations SET memory_consent=true WHERE id=$1",
        [session],
      );
      const atomId = randomUUID(),
        hash = claimTextHash("Player A starts.");
      const exp = await recordLearningExperience(pool, owner, {
        requestId: randomUUID(),
        sessionId: session,
        runId: message,
        eventId: "game",
        modelVersion: "synthetic",
        promptVersion: "test",
        prerequisites: [],
        outcome: null,
        atoms: [
          {
            id: atomId,
            origin: "tool_result",
            reference: `${message}:result:official-lineup:1`,
            version: 1,
            hash,
            text: "Player A starts.",
            eventId: "game",
            publishedAt: null,
            occurredAt: null,
            retrievedAt,
            sourceOrigin: "official:lineup",
          },
        ],
      });
      const candidate = await createLessonCandidate(pool, owner, {
        requestId: randomUUID(),
        kind: "research_procedure",
        scope: { domain: "Sports", eventId: "game" },
        statement: "Check the official lineup before changing.",
        experienceIds: [exp.id],
        evidence: [
          {
            atomId,
            version: 1,
            hash,
            stance: "support",
            quote: "Player A starts.",
          },
        ],
        modelVersion: "synthetic",
        promptVersion: "test",
        condition: {
          type: "require_official_lineup",
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
      });
      await reviewLessonCandidate(pool, owner, candidate.id, {
        requestId: randomUUID(),
        baseVersion: 1,
        action: "approve",
        confirmed: true,
        memoryConsent: true,
      });
      lessonId = (await loadCurrentApprovedLessons(pool, owner))[0]!.id;
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [
        "CHALLENGE-" + message,
      ]);
      await pool.end();
    });
    it("rejects cross account anchors before any verification and preserves idempotency", async () => {
      await expect(submitClaimChallenge(pool, other, body)).rejects.toThrow(
        "NOT_FOUND",
      );
      expect(
        (await loadCurrentApprovedLessons(pool, owner)).map((l) => l.id),
      ).toContain(lessonId);
      const first = await submitClaimChallenge(pool, owner, body),
        again = await submitClaimChallenge(pool, owner, body);
      expect(first.id).toBe(again.id);
      expect(await loadCurrentApprovedLessons(pool, owner)).toEqual([]);
      expect(
        (
          await pool.query(
            "SELECT approval,status FROM lesson_versions WHERE lesson_id=$1",
            [lessonId],
          )
        ).rows[0],
      ).toMatchObject({ approval: "approved", status: "active" });
      await expect(
        submitClaimChallenge(pool, owner, {
          ...body,
          explanation: "Different",
        }),
      ).rejects.toThrow("REQUEST_ID_REUSED");
      await expect(readClaimChallenge(pool, other, first.id)).rejects.toThrow(
        "NOT_FOUND",
      );
    });
    it("missing evidence yields needs_evidence and leaves the original answer unchanged", async () => {
      await runOneClaimChallengeJob(pool, { ownerId: owner, hosts: [] });
      const row = await submitClaimChallenge(pool, owner, body),
        review = await readClaimChallenge(pool, owner, row.id);
      expect(review.status).toBe("needs_evidence");
      expect(review.revisions.at(-1).revision.correctionText).toBeNull();
      expect(
        (
          await pool.query("SELECT result FROM agent_runs WHERE id=$1", [
            message,
          ])
        ).rows[0].result.reply.message,
      ).toBe("Player A starts.");
      await expect(
        withdrawClaimChallenge(pool, owner, row.id, {
          action: "withdraw",
          expectedRevision: 1,
        }),
      ).rejects.toThrow("REVISION_CONFLICT");
      await withdrawClaimChallenge(pool, owner, row.id, {
        action: "withdraw",
        expectedRevision: review.current_revision,
      });
      expect((await readClaimChallenge(pool, owner, row.id)).status).toBe(
        "withdrawn",
      );
      expect(
        (await loadCurrentApprovedLessons(pool, owner)).map((l) => l.id),
      ).toContain(lessonId);
    });
    it('exhausted model retries clearly require evidence without inventing a correction',async()=>{
      const challenge=await submitClaimChallenge(pool,owner,{...body,clientRequestId:randomUUID(),evidenceUrls:['https://official.example/report']});
      await pool.query("UPDATE learning_jobs SET attempts=4 WHERE user_id=$1 AND kind='claim_challenge' AND operation_key=$2",[owner,challenge.id]);
      await runOneClaimChallengeJob(pool,{ownerId:owner,hosts:['official.example'],fetchText:async()=>({text:'A report.',contentType:'text/plain'}),verify:async()=>{throw Error('MODEL_UNAVAILABLE');}});
      const review=await readClaimChallenge(pool,owner,challenge.id);expect(review.status).toBe('needs_evidence');expect(review.revisions.at(-1).revision.correctionText).toBeNull();
    });
    it('newly retrieved evidence cannot rewrite a historical forecast cutoff',async()=>{
      await pool.query("UPDATE agent_runs SET result=jsonb_set(result,'{temporalContext}',$2::jsonb) WHERE id=$1",[message,JSON.stringify({mode:'historical',cutoff:'2026-01-01T00:00:00.000Z'})]);
      const challenge=await submitClaimChallenge(pool,owner,{...body,clientRequestId:randomUUID(),evidenceUrls:['https://official.example/history']});
      await runOneClaimChallengeJob(pool,{ownerId:owner,hosts:['official.example'],fetchText:async()=>({text:'Player A did not start.',contentType:'text/plain'}),verify:async({sources})=>({status:'accepted',explanation:'Different lineup.',correctionText:'Replace original forecast.',citations:[{evidenceId:sources[0]!.id,quote:sources[0]!.text}]})});
      const review=await readClaimChallenge(pool,owner,challenge.id);expect(review.status).toBe('needs_evidence');expect(review.revisions.at(-1).revision.explanation).toContain('original historical cutoff');
    });
  },
);
