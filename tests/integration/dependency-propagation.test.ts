import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createPick,
  proposePick,
  confirmPick,
} from "../../packages/db/src/picks";
import {
  createEventDossier,
  readEventDossier,
} from "../../packages/db/src/event-dossier";
import { recordDecisionDependencies } from "../../packages/db/src/decision-dependencies";
import { commitLessonVersion } from "../../packages/db/src/versioning";
import {
  lessonRowToPayload,
  claimMemoryOutbox,
  finishMemoryOutbox,
} from "../../packages/db/src/memory-outbox";
import { learningSnapshotHash } from "../../packages/agent/src/learning-provenance";
import { runOneEventDossierJob } from "../../packages/integrations/src/event-dossier-worker";
import { setChatMemoryConsent } from "../../packages/db/src/chat-sessions";
import { setActionMemoryConsent } from "../../packages/db/src/action-history";
import {
  registerSourceForecast,
  recordSourceFactReview,
  controlSource,
  listSourceScores,
} from "../../packages/db/src/source-credibility";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "registered dependency propagation",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID(),
      other = randomUUID();
    beforeAll(async () => {
      for (const id of [owner, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
      await pool.end();
    });
    it("confirmed pick updates trusted protected blocks in the linked dossier only", async () => {
      const nativeId = randomUUID(),
        eventId = randomUUID(),
        snapshot = {
          platform: "kalshi",
          nativeId,
          eventId,
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
          raw: { scheduledAt: new Date(Date.now() + 86400000).toISOString() },
        };
      const saved = (await createPick(
        pool,
        owner,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "Original",
          requestId: randomUUID(),
        },
        async () => snapshot,
      )) as { pickId: string };
      const pick = {
        id: saved.pickId,
        version: 1,
        outcome: "Yes",
        reason: "Original",
      };
      await createEventDossier(pool, owner, {
        ownerId: owner,
        eventId,
        revision: 1,
        checkedAt: new Date().toISOString(),
        blocks: {
          savedView: {
            text: JSON.stringify(pick),
            dependencies: [
              {
                id: `pick:${pick.id}`,
                version: 1,
                hash: learningSnapshotHash(pick),
                status: "current",
              },
            ],
          },
          evidence: { text: "Unrelated exact evidence", dependencies: [] },
        },
      });
      const p = (await proposePick(pool, owner, saved.pickId, {
        baseVersion: 1,
        requestId: randomUUID(),
        changes: { outcome: "No", reason: "Reviewed" },
        reason: "Fixture",
      })) as { proposalId: string };
      await confirmPick(
        pool,
        owner,
        saved.pickId,
        { proposalId: p.proposalId, requestId: randomUUID(), confirmed: true },
        snapshot,
      );
      expect(
        (await readEventDossier(pool, owner, eventId))?.blocks.savedView
          ?.dependencies[0]?.status,
      ).toBe("pending_consolidation");
      expect(await runOneEventDossierJob(pool, owner)).toEqual({
        checked: 1,
        completed: 1,
      });
      const updated = await readEventDossier(pool, owner, eventId);
      expect(JSON.parse(updated!.blocks.savedView!.text)).toMatchObject({
        version: 2,
        outcome: "No",
        reason: "Reviewed",
      });
      expect(updated?.blocks.evidence?.text).toBe("Unrelated exact evidence");
      expect(await readEventDossier(pool, other, eventId)).toBeNull();
    });
    it("approved condition revision syncs only after verified publication and pause removes it", async () => {
      const lessonId = randomUUID(),
        eventId = randomUUID();
      await pool.query("INSERT INTO lessons(id,user_id) VALUES($1,$2)", [
        lessonId,
        owner,
      ]);
      await pool.query(
        "INSERT INTO lesson_versions(lesson_id,user_id,version,rule,scope,approval,status,effective_at) VALUES($1,$2,1,'Wait for official lineup before reconsidering','{\"domain\":\"Sports\"}','approved','active',clock_timestamp())",
        [lessonId, owner],
      );
      const old = lessonRowToPayload(
        (
          await pool.query("SELECT * FROM lesson_versions WHERE lesson_id=$1", [
            lessonId,
          ])
        ).rows[0],
      );
      await createEventDossier(pool, owner, {
        ownerId: owner,
        eventId,
        revision: 1,
        checkedAt: new Date().toISOString(),
        blocks: {
          conditions: {
            text: JSON.stringify([
              { id: lessonId, version: 1, condition: "official_lineup" },
            ]),
            dependencies: [
              {
                id: `lesson:${lessonId}`,
                version: 1,
                hash: learningSnapshotHash(old),
                status: "current",
              },
            ],
          },
        },
      });
      await recordDecisionDependencies(pool, {
        userId: owner,
        decisionId: randomUUID(),
        eventId,
        monitoring: true,
        consent: true,
        dependencies: [
          {
            id: lessonId,
            version: 1,
            hash: learningSnapshotHash(old),
            status: "current",
          },
        ],
      });
      const condition = {
        type: "require_fresh_quote" as const,
        maxAgeSeconds: 60,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
      await commitLessonVersion(pool, {
        userId: owner,
        lessonId,
        baseVersion: 1,
        requestId: randomUUID(),
        memoryConsent: true,
        next: {
          rule: "Require a fresh quote",
          scope: { domain: "Sports" },
          approval: "approved",
          status: "active",
          effectiveAt: new Date().toISOString(),
          expiresAt: null,
          supersededBy: null,
          learningCondition: condition,
        },
      });
      expect(await runOneEventDossierJob(pool, owner)).toEqual({
        checked: 1,
        completed: 1,
      });
      expect(
        JSON.parse(
          (await readEventDossier(pool, owner, eventId))!.blocks.conditions!
            .text,
        ),
      ).toEqual([]);
      const claim = await claimMemoryOutbox(pool, 120000, owner);
      expect(claim).not.toBeNull();
      await finishMemoryOutbox(pool, claim!, {
        status: "verified",
        hash: "a".repeat(64),
        blobId: "test-only",
      });
      expect(await runOneEventDossierJob(pool, owner)).toEqual({
        checked: 1,
        completed: 1,
      });
      expect(
        JSON.parse(
          (await readEventDossier(pool, owner, eventId))!.blocks.conditions!
            .text,
        )[0],
      ).toMatchObject({
        id: lessonId,
        version: 2,
        condition: "require_fresh_quote",
      });
      await commitLessonVersion(pool, {
        userId: owner,
        lessonId,
        baseVersion: 2,
        requestId: randomUUID(),
        memoryConsent: false,
        next: {
          rule: "Paused",
          scope: { domain: "Sports" },
          approval: "approved",
          status: "paused",
          effectiveAt: new Date().toISOString(),
          expiresAt: null,
          supersededBy: null,
          learningCondition: condition,
        },
      });
      expect(await runOneEventDossierJob(pool, owner)).toEqual({
        checked: 1,
        completed: 1,
      });
      expect(
        JSON.parse(
          (await readEventDossier(pool, owner, eventId))!.blocks.conditions!
            .text,
        ),
      ).toEqual([]);
    });
    it("source fact revision and source pause target registered dependencies, preserving uncertainty", async () => {
      const source = await registerSourceForecast(pool, owner, {
        platform: "kalshi",
        nativeId: randomUUID(),
        sourceId: randomUUID(),
        sourceName: "Fixture",
        kind: "user_reported_forecaster",
        cohort: "NBA",
        outcome: "Yes",
        probability: 0.6,
        baselineProbability: 0.5,
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
        reference: "https://example.com",
        rulesHash: "fixture",
        memoryConsent: true,
      });
      const score = (await listSourceScores(pool, owner)).find(
        (r) => r.id === source.sourceProfileId,
      )!;
      const decisionId = randomUUID();
      await recordDecisionDependencies(pool, {
        userId: owner,
        decisionId,
        eventId: "e",
        monitoring: true,
        consent: true,
        dependencies: [
          {
            id: `source:${source.sourceProfileId}`,
            version: score.payload.version,
            hash: learningSnapshotHash(score.payload),
            status: "current",
          },
        ],
      });
      await recordSourceFactReview(pool, owner, {
        profileId: source.sourceProfileId,
        requestId: randomUUID(),
        claim: "Fixture claim",
        sourceReference: "https://example.com/source",
        evidenceReference: "https://example.com/evidence",
        verdict: "unclear",
        scope: { league: "NBA", market: "winner", horizon: "pregame" },
        confirmed: true,
      });
      const jobs = () =>
        pool.query(
          "SELECT payload FROM learning_jobs WHERE user_id=$1 AND kind='advice_review' AND payload->>'decisionId'=$2",
          [owner, decisionId],
        );
      expect((await jobs()).rows[0].payload.status).toBe("current");
      expect((await jobs()).rows[0].payload.dependencyId).toBe(
        `source:${source.sourceProfileId}`,
      );
      await controlSource(pool, owner, source.sourceProfileId, "paused");
      expect((await jobs()).rows.map((r) => r.payload.status)).toContain(
        "revoked",
      );
    });
    it("session consent revocation is transactional and does not target another owner", async () => {
      const sessionId = randomUUID(),
        runId = randomUUID(),
        decisionId = randomUUID(),
        dep = randomUUID();
      await pool.query(
        "INSERT INTO markets(platform,native_id) VALUES('kalshi','CONSENT') ON CONFLICT DO NOTHING",
      );
      await pool.query(
        "INSERT INTO conversations(id,user_id,platform,native_id,memory_consent) VALUES($1,$2,'kalshi','CONSENT',true)",
        [sessionId, owner],
      );
      await pool.query(
        "INSERT INTO agent_runs(id,user_id,conversation_id,request_id,payload_hash,provider,message,status,platform,native_id,result) VALUES($1,$2,$3,$4,'fixture','public','fixture','completed','kalshi','CONSENT','{}')",
        [runId, owner, sessionId, randomUUID()],
      );
      await pool.query(
        "INSERT INTO markets(platform,native_id) VALUES('kalshi','CONSENT') ON CONFLICT DO NOTHING",
      );
      // Register exact evidence through a dossier; no unrelated account memory is selected.
      const unrelatedEvent = randomUUID();
      await createEventDossier(pool, owner, {
        ownerId: owner,
        eventId: unrelatedEvent,
        revision: 1,
        checkedAt: new Date().toISOString(),
        blocks: {
          evidence: {
            text: "Other event",
            dependencies: [
              {
                id: `evidence:${dep}`,
                version: 1,
                hash: "a".repeat(64),
                status: "current",
              },
            ],
          },
        },
      });
      await createEventDossier(pool, owner, {
        ownerId: owner,
        eventId: decisionId,
        revision: 1,
        checkedAt: new Date().toISOString(),
        blocks: {
          evidence: {
            text: "Original",
            dependencies: [
              {
                id: `evidence:${dep}`,
                version: 1,
                hash: "a".repeat(64),
                status: "current",
              },
            ],
          },
        },
      });
      await pool.query(
        "UPDATE agent_runs SET result=$3 WHERE id=$1 AND user_id=$2",
        [
          runId,
          owner,
          JSON.stringify({
            learningEventId: decisionId,
            learningEvidence: [{ id: dep }],
          }),
        ],
      );
      await expect(
        setChatMemoryConsent(pool, other, sessionId, false),
      ).rejects.toThrow("SESSION_NOT_FOUND");
      await setChatMemoryConsent(pool, owner, sessionId, false);
      expect(
        (await readEventDossier(pool, owner, decisionId))?.blocks.evidence
          ?.dependencies[0]?.status,
      ).toBe("revoked");
      expect(
        (await readEventDossier(pool, owner, unrelatedEvent))?.blocks.evidence
          ?.dependencies[0]?.status,
      ).toBe("current");
      const experienceId = randomUUID(),
        atomId = randomUUID(),
        actionDecision = randomUUID();
      await pool.query(
        "INSERT INTO learning_experiences(id,user_id,request_id,request_hash,session_id,run_id,event_id,payload) VALUES($1,$2,$3,'fixture',$4,$5,$6,'{}')",
        [experienceId, owner, randomUUID(), sessionId, runId, decisionId],
      );
      await pool.query(
        'INSERT INTO memory_atoms(id,user_id,version,experience_id,hash,payload) VALUES($1,$2,1,$3,$4,\'{"origin":"verified_outcome"}\')',
        [atomId, owner, experienceId, "a".repeat(64)],
      );
      await recordDecisionDependencies(pool, {
        userId: owner,
        decisionId: actionDecision,
        eventId: decisionId,
        monitoring: true,
        consent: true,
        dependencies: [
          { id: atomId, version: 1, hash: "a".repeat(64), status: "current" },
        ],
      });
      await setActionMemoryConsent(pool, owner, false);
      expect(
        (
          await pool.query(
            "SELECT payload->>'status' AS status FROM learning_jobs WHERE user_id=$1 AND kind='advice_review' AND payload->>'decisionId'=$2",
            [owner, actionDecision],
          )
        ).rows,
      ).toEqual([{ status: "revoked" }]);
    });
  },
);
