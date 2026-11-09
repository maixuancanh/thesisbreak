import {
  deriveResearchArtifact,
  enqueueResearchArtifactMemory,
  loadResearchArtifactMemory,
} from "../../packages/db/src/research-artifact-memory";
import {
  inspectResearchArtifact,
  grantResearchArtifactConsent,
  revokeResearchArtifactConsent,
} from "../../packages/db/src/research-artifact-consent";
import {
  runResearchArtifactMemoryOnce,
  recallResearchArtifactForPlanning,
} from "../../packages/integrations/src/research-artifact-memory";
import {
  researchMemoryBytes,
  researchMemoryHash,
} from "../../packages/domain/src/research-memory-version";
import type {
  MemoryRecord,
  MemoryEnvelope,
} from "../../packages/integrations/src/memwal";
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
} from "../../packages/db/src/claim-challenges";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "local synthetic accountability artifact authority",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID(),
      session = randomUUID(),
      message = randomUUID(),
      nativeId = "ARTIFACT-" + randomUUID();
    let pickId = "";
    let artifactId = "";
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
      await pool.query(
        "INSERT INTO action_memory_preferences(user_id,memory_consent) VALUES($1,true)",
        [owner],
      );
      await submitClaimChallenge(pool, owner, {
        messageId: message,
        answerRevision: 1,
        claimId: "lineup",
        explanation: "Source certainty needs review.",
        evidenceUrls: [],
        clientRequestId: randomUUID(),
      });
      artifactId = (await readDecisionRecap(pool, owner, pickId))!
        .explanationReview!.id;
    });
    afterAll(async () => {
      for (const table of [
        "research_artifact_memory_publications",
        "research_artifact_memory_inspections",
        "research_artifact_memory_grants",
      ])
        await pool.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
      await pool.query("DELETE FROM users WHERE id=$1", [owner]);
      await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    });

    let publicationId = "",
      grantId = "";
    const records = new Map<
      string,
      { record: MemoryEnvelope; blobId: string; text: string }
    >();
    let beforeRecall: (() => Promise<void>) | null = null;
    const adapter = () => ({
      remember: async (record: MemoryRecord) => {
        const text = researchMemoryBytes(owner, record),
          hash = researchMemoryHash(owner, record),
          blobId = "synthetic-local-" + hash;
        records.set(text, { record: JSON.parse(text), blobId, text });
        return { status: "verified", hash, blobId };
      },
      recall: async (text: string) => {
        if (beforeRecall) await beforeRecall();
        return {
          sources: records.has(text) ? [records.get(text)!] : [],
          conflicts: [],
          conflictingBlobs: [],
        };
      },
      destroy: () => {},
    });
    it("requires new exact consent and verifies write/fresh-read in a local fake adapter", async () => {
      const snapshot = await deriveResearchArtifact(
        pool,
        owner,
        "accountability_review",
        artifactId,
      );
      expect(snapshot.snapshot).toHaveProperty("challenges");
      await expect(
        enqueueResearchArtifactMemory(pool, {
          ownerId: owner,
          reviewerId: owner,
          kind: "accountability_review",
          artifactId,
          grantId: randomUUID(),
        }),
      ).rejects.toThrow();
      const inspection = await inspectResearchArtifact(
        pool,
        owner,
        "accountability_review",
        artifactId,
      );
      const grant = await grantResearchArtifactConsent(pool, owner, {
        inspectionId: inspection.inspectionId,
        snapshotHash: inspection.snapshotHash,
      });
      grantId = grant.id;
      publicationId = await enqueueResearchArtifactMemory(pool, {
        ownerId: owner,
        reviewerId: owner,
        kind: "accountability_review",
        artifactId,
        grantId,
      });
      expect(
        await runResearchArtifactMemoryOnce(pool, {
          id: publicationId,
          ownerId: owner,
          reviewerId: owner,
          enabled: true,
          createAdapter: adapter,
        }),
      ).toMatchObject({ verified: 1 });
      expect(
        await recallResearchArtifactForPlanning(pool, {
          id: publicationId,
          ownerId: owner,
          reviewerId: owner,
          createAdapter: adapter,
        }),
      ).toMatchObject({
        status: "verified",
        checks: ["recheck_disputed_claim_dependencies"],
      });
    });
    it("post-read authority fences a changed explanation revision and preserves the receipt history", async () => {
      beforeRecall = async () => {
        beforeRecall = null;
        await submitClaimChallenge(pool, owner, {
          messageId: message,
          answerRevision: 1,
          claimId: "lineup",
          explanation: "New counterevidence requires another revision.",
          evidenceUrls: [],
          clientRequestId: randomUUID(),
        });
      };
      expect(
        await recallResearchArtifactForPlanning(pool, {
          id: publicationId,
          ownerId: owner,
          reviewerId: owner,
          createAdapter: adapter,
        }),
      ).toMatchObject({ status: "blocked" });
      const receipt = (
        await pool.query(
          "SELECT receipt FROM research_artifact_memory_publications WHERE id=$1",
          [publicationId],
        )
      ).rows[0].receipt;
      expect(receipt.blobId).toContain("synthetic-local-");
      await expect(
        loadResearchArtifactMemory(pool, {
          id: publicationId,
          ownerId: owner,
          reviewerId: owner,
        }),
      ).rejects.toThrow("RESEARCH_ARTIFACT_NOT_AVAILABLE");
    });
    it("revocation during a remote read blocks current artifact use", async () => {
      artifactId = (await readDecisionRecap(pool, owner, pickId))!
        .explanationReview!.id;
      const view = await inspectResearchArtifact(
          pool,
          owner,
          "accountability_review",
          artifactId,
        ),
        grant = await grantResearchArtifactConsent(pool, owner, {
          inspectionId: view.inspectionId,
          snapshotHash: view.snapshotHash,
        });
      const id = await enqueueResearchArtifactMemory(pool, {
        ownerId: owner,
        reviewerId: owner,
        kind: "accountability_review",
        artifactId,
        grantId: grant.id,
      });
      await runResearchArtifactMemoryOnce(pool, {
        id,
        ownerId: owner,
        reviewerId: owner,
        enabled: true,
        createAdapter: adapter,
      });
      beforeRecall = async () => {
        beforeRecall = null;
        await revokeResearchArtifactConsent(pool, owner, grant.id);
      };
      expect(
        await recallResearchArtifactForPlanning(pool, {
          id,
          ownerId: owner,
          reviewerId: owner,
          createAdapter: adapter,
        }),
      ).toMatchObject({ status: "blocked" });
      expect(
        (
          await pool.query(
            "SELECT state,receipt FROM research_artifact_memory_publications WHERE id=$1",
            [id],
          )
        ).rows[0],
      ).toMatchObject({ state: "blocked", receipt: expect.any(Object) });
    });
  },
);
