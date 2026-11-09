import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  inspectResearchArtifact,
  grantResearchArtifactConsent,
  revokeResearchArtifactConsent,
} from "../../packages/db/src/research-artifact-consent";
import {
  enqueueResearchArtifactMemory,
  loadResearchArtifactMemory,
  claimResearchArtifactMemory,
  finishResearchArtifactMemory,
  markResearchArtifactFreshRead,
  prepareNextResearchArtifactMemory,
} from "../../packages/db/src/research-artifact-memory";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "owner artifact consent without global reviewer authority",
  () => {
    const pool = new Pool({ connectionString: url }),
      owner = randomUUID(),
      other = randomUUID(),
      artifactId = randomUUID();
    beforeAll(async () => {
      for (const id of [owner, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
      await pool.query(
        "INSERT INTO nba_forecasts(id,user_id,namespace,event_id,horizon,method_version,scheduled_at,captured_at,request_hash,payload,memory_consent) VALUES($1,$2,'replay:consent','event','T24h','test','2026-11-03','2026-11-01',$3,$4,true)",
        [
          artifactId,
          owner,
          "a".repeat(64),
          { rationale: "Retained original reasoning" },
        ],
      );
    });
    afterAll(async () => {
      await pool.query(
        "DELETE FROM research_artifact_memory_publications WHERE owner_id=$1",
        [owner],
      );
      await pool.query(
        "DELETE FROM research_artifact_memory_inspections WHERE owner_id=$1",
        [owner],
      );
      await pool.query(
        "DELETE FROM research_artifact_memory_grants WHERE owner_id=$1",
        [owner],
      );
      await pool.query("DELETE FROM users WHERE id=ANY($1::text[])", [
        [owner, other],
      ]);
      await pool.end();
    });
    it("requires owned inspection and exact hash; personal grant never grants procedure review", async () => {
      await expect(
        inspectResearchArtifact(pool, other, "forecast_rationale", artifactId),
      ).rejects.toThrow("RESEARCH_ARTIFACT_NOT_AVAILABLE");
      const view = await inspectResearchArtifact(
        pool,
        owner,
        "forecast_rationale",
        artifactId,
      );
      await expect(
        grantResearchArtifactConsent(pool, other, {
          inspectionId: view.inspectionId,
          snapshotHash: view.snapshotHash,
        }),
      ).rejects.toThrow("INSPECTION_NOT_AVAILABLE");
      await expect(
        grantResearchArtifactConsent(pool, owner, {
          inspectionId: view.inspectionId,
          snapshotHash: "b".repeat(64),
        }),
      ).rejects.toThrow("INSPECTION_NOT_AVAILABLE");
      const grant = await grantResearchArtifactConsent(pool, owner, {
        inspectionId: view.inspectionId,
        snapshotHash: view.snapshotHash,
      });
      expect(grant.authority_kind).toBe("owner");
      expect(grant.consented_at).toBeInstanceOf(Date);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM procedure_reviewer_authorizations WHERE user_id=$1",
            [owner],
          )
        ).rowCount,
      ).toBe(0);
      const prepared = await prepareNextResearchArtifactMemory(pool);
      expect(prepared.prepared).toBe(1);
      const id = await enqueueResearchArtifactMemory(pool, {
        ownerId: owner,
        reviewerId: owner,
        grantId: grant.id,
        kind: "forecast_rationale",
        artifactId,
      });
      expect(prepared.publicationId).toBe(id);
      const claim = await claimResearchArtifactMemory(pool, {
        id,
        ownerId: owner,
        reviewerId: owner,
      });
      expect(claim).not.toBeNull();
      expect(
        await finishResearchArtifactMemory(pool, claim!, {
          status: "verified",
          hash: claim!.recordHash,
          blobId: "test-only-receipt",
        }),
      ).toBe(true);
      const saved = await loadResearchArtifactMemory(pool, {
        id,
        ownerId: owner,
        reviewerId: owner,
      });
      expect(await markResearchArtifactFreshRead(pool, saved)).toBe(true);
      await expect(
        pool.query(
          "UPDATE research_artifact_memory_grants SET snapshot_hash=$2 WHERE id=$1",
          [grant.id, "b".repeat(64)],
        ),
      ).rejects.toThrow("RESEARCH_ARTIFACT_GRANT_IMMUTABLE");
      await expect(
        enqueueResearchArtifactMemory(pool, {
          ownerId: owner,
          reviewerId: other,
          grantId: grant.id,
          kind: "forecast_rationale",
          artifactId,
        }),
      ).rejects.toThrow("RESEARCH_ARTIFACT_AUTHORITY_DENIED");
      await expect(
        revokeResearchArtifactConsent(pool, other, grant.id),
      ).resolves.toBe(false);
      expect(await revokeResearchArtifactConsent(pool, owner, grant.id)).toBe(
        true,
      );
      await expect(
        loadResearchArtifactMemory(pool, {
          id,
          ownerId: owner,
          reviewerId: owner,
        }),
      ).rejects.toThrow("RESEARCH_ARTIFACT_AUTHORITY_DENIED");
      expect(
        (
          await pool.query(
            "SELECT state FROM research_artifact_memory_publications WHERE id=$1",
            [id],
          )
        ).rows[0].state,
      ).toBe("blocked");
    });
    it("rejects expired inspection and never revives revoked consent on retry", async () => {
      const view = await inspectResearchArtifact(
        pool,
        owner,
        "forecast_rationale",
        artifactId,
      );
      await pool.query(
        "UPDATE research_artifact_memory_inspections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [view.inspectionId],
      );
      await expect(
        grantResearchArtifactConsent(pool, owner, {
          inspectionId: view.inspectionId,
          snapshotHash: view.snapshotHash,
        }),
      ).rejects.toThrow("INSPECTION_NOT_AVAILABLE");
      const next = await inspectResearchArtifact(
        pool,
        owner,
        "forecast_rationale",
        artifactId,
      );
      const input = {
        inspectionId: next.inspectionId,
        snapshotHash: next.snapshotHash,
      };
      const grant = await grantResearchArtifactConsent(pool, owner, input);
      expect((await grantResearchArtifactConsent(pool, owner, input)).id).toBe(
        grant.id,
      );
      await revokeResearchArtifactConsent(pool, owner, grant.id);
      await expect(
        grantResearchArtifactConsent(pool, owner, input),
      ).rejects.toThrow("CONSENT_REVOKED");
    });
    it("recomputes the current retained snapshot rather than trusting inspection hash", async () => {
      const view = await inspectResearchArtifact(
        pool,
        owner,
        "forecast_rationale",
        artifactId,
      );
      await pool.query(
        "UPDATE research_artifact_memory_inspections SET snapshot_hash=$2 WHERE id=$1",
        [view.inspectionId, "b".repeat(64)],
      );
      await expect(
        grantResearchArtifactConsent(pool, owner, {
          inspectionId: view.inspectionId,
          snapshotHash: "b".repeat(64),
        }),
      ).rejects.toThrow("RESEARCH_ARTIFACT_SNAPSHOT_CHANGED");
    });
  },
);
