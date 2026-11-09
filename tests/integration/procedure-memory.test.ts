import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createProcedureVersion } from "../../packages/domain/src/procedure-version";
import {
  getActiveProcedure,
  saveProcedureDraft,
  sealProcedureEvaluation,
  reviewProcedureCandidate,
  promoteProcedure,
} from "../../packages/db/src/procedure-versions";
import {
  enqueueProcedureMemory,
  claimProcedureMemory,
  finishProcedureMemory,
  loadProcedureMemory,
  assertProcedureMemoryAuthority,
  markProcedureFreshRead,
} from "../../packages/db/src/procedure-memory";
import {
  publishProcedureProvenance,
  verifyProcedureProvenance,
} from "../../packages/integrations/src/procedure-memory";
import {
  MemwalAdapter,
  type MemoryClient,
} from "../../packages/integrations/src/memwal";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "procedure Walrus publication with real authority DB and offline transport",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const owner = randomUUID(),
      reviewer = randomUUID(),
      foreign = randomUUID(),
      procedureId = randomUUID(),
      grantId = randomUUID();
    let oldId: string | null = null;
    let lock: PoolClient;
    beforeAll(async () => {
      lock = await pool.connect();
      await lock.query("SELECT pg_advisory_lock(8671220)");
      const old = await getActiveProcedure(pool);
      oldId = old?.id ?? null;
      await pool.query(
        "INSERT INTO users(id,provider_subject) VALUES($1,$1),($2,$2),($3,$3)",
        [owner, reviewer, foreign],
      );
      await pool.query(
        "INSERT INTO procedure_reviewer_authorizations(user_id) VALUES($1)",
        [reviewer],
      );
      const v = createProcedureVersion({
        id: procedureId,
        parentId: oldId,
        parentHash: old?.hash ?? null,
        content: {
          researchInstructions: "Read official evidence",
          queryTemplates: [],
          proposedReadOrder: [],
        },
        corpusVersion: "synthetic-proof",
        failureExampleIds: [],
      });
      await saveProcedureDraft(pool, reviewer, v);
      await sealProcedureEvaluation(pool, reviewer, v.id, {
        reportHash: "b".repeat(64),
        corpusVersion: v.corpusVersion,
        criticalViolations: [],
        grounding: 1,
        actionCompliance: 1,
        latencyMs: 1,
        costUsd: 0,
        validationPassed: true,
        sealedTestPassed: true,
      });
      await reviewProcedureCandidate(pool, reviewer, v.id, true);
      await promoteProcedure(pool, {
        reviewerId: reviewer,
        versionId: v.id,
        expectedActiveId: oldId,
        reason: "Synthetic test fixture only",
      });
      await pool.query(
        "INSERT INTO procedure_memory_grants(id,owner_id,procedure_id,procedure_hash,namespace_kind,consent_evidence_ref,consented_at) VALUES($1,$2,$3,$4,'evaluation','synthetic-explicit-consent',clock_timestamp())",
        [grantId, owner, v.id, v.hash],
      );
    });
    afterAll(async () => {
      await pool.query(
        "DELETE FROM procedure_memory_publications WHERE procedure_id=$1",
        [procedureId],
      );
      await pool.query("DELETE FROM procedure_memory_grants WHERE id=$1", [
        grantId,
      ]);
      await pool.query(
        "UPDATE procedure_versions SET status='retired' WHERE id=$1",
        [procedureId],
      );
      await pool.query(
        "UPDATE procedure_active_state SET active_id=$1 WHERE singleton=true",
        [oldId],
      );
      if (oldId)
        await pool.query(
          "UPDATE procedure_versions SET status='active' WHERE id=$1",
          [oldId],
        );
      await pool.query("DELETE FROM procedure_reviews WHERE version_id=$1", [
        procedureId,
      ]);
      await pool.query("DELETE FROM procedure_versions WHERE id=$1", [
        procedureId,
      ]);
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [
        [owner, reviewer, foreign],
      ]);
      await lock.query("SELECT pg_advisory_unlock(8671220)");
      lock.release();
      await pool.end();
    });
    it("requires exact consent, stable immutable queue, matching receipt and separate fresh remote proof", async () => {
      const args = {
        ownerId: owner,
        reviewerId: reviewer,
        procedureId,
        grantId,
      };
      await expect(
        enqueueProcedureMemory(pool, { ...args, ownerId: foreign }),
      ).rejects.toThrow("AUTHORITY");
      const id = await enqueueProcedureMemory(pool, args);
      expect(await enqueueProcedureMemory(pool, args)).toBe(id);
      const claim = (await claimProcedureMemory(pool, {
        id,
        ownerId: owner,
        reviewerId: reviewer,
      }))!;
      expect(
        await claimProcedureMemory(pool, {
          id,
          ownerId: owner,
          reviewerId: reviewer,
        }),
      ).toBeNull();
      await expect(
        pool.query(
          "UPDATE procedure_memory_publications SET record='{}' WHERE id=$1",
          [id],
        ),
      ).rejects.toThrow("IMMUTABLE");
      let text = "",
        namespace = "",
        writes = 0,
        mode = "valid";
      const keys: string[] = [];
      const hooks: { afterRecall?: () => Promise<void> } = {};
      const transport = (): MemoryClient => ({
        rememberAndWait: async (t, n, o) => {
          writes++;
          text = t;
          namespace = n;
          keys.push(o.idempotencyKey);
          return {
            id: "job",
            blob_id: "receipt-blob",
            owner: "test",
            namespace: n,
          };
        },
        recall: async (q) => {
          await hooks.afterRecall?.();
          let content = text;
          if (mode === "wrong-owner") {
            const parsed = JSON.parse(content);
            parsed.userId = foreign;
            content = JSON.stringify(parsed);
          }
          if (mode === "wrong-hash") {
            const parsed = JSON.parse(content);
            parsed.hash = "e".repeat(64);
            content = JSON.stringify(parsed);
          }
          const hits =
            q.namespace === namespace
              ? [
                  {
                    text: content,
                    distance: 0,
                    blob_id:
                      mode === "wrong-blob" ? "other-blob" : "receipt-blob",
                  },
                ]
              : [];
          return { results: hits, total: hits.length };
        },
        restore: async (n) => ({
          restored: 1,
          skipped: 0,
          failed: 0,
          total: 1,
          truncated: false,
          owner: "test",
          namespace: n,
        }),
        destroy: () => {},
      });
      const writer = new MemwalAdapter(
        transport(),
        owner,
        "procedure_provenance",
      );
      const deps = {
        assertAuthority: () => assertProcedureMemoryAuthority(pool, claim),
      };
      const receipt = await publishProcedureProvenance(claim, {
        ...deps,
        remember: (r) => writer.remember(r),
      });
      expect(receipt.status).toBe("verified");
      expect(await finishProcedureMemory(pool, claim, receipt)).toBe(true);
      expect(await finishProcedureMemory(pool, claim, receipt)).toBe(false);
      writer.destroy();
      const persisted = await loadProcedureMemory(pool, {
        id,
        ownerId: owner,
        reviewerId: reviewer,
      });
      expect(persisted.receipt).not.toBeNull();
      const fresh = new MemwalAdapter(
        transport(),
        owner,
        "procedure_provenance",
      );
      const input = { ...persisted, receipt: persisted.receipt! };
      for (const bad of ["wrong-owner", "wrong-hash", "wrong-blob"]) {
        mode = bad;
        expect(
          (
            await verifyProcedureProvenance(input, {
              ...deps,
              recall: (q) => fresh.recall(q),
            })
          ).status,
        ).toBe("blocked");
      }
      mode = "valid";
      const proof = await verifyProcedureProvenance(input, {
        ...deps,
        recall: (q) => fresh.recall(q),
      });
      expect(proof.status).toBe("verified");
      expect(
        await markProcedureFreshRead(pool, claim, persisted.receipt!),
      ).toBe(true);
      const personal = new MemwalAdapter(transport(), owner);
      expect(personal.namespace).not.toBe(fresh.namespace);
      expect((await personal.recall("procedure")).sources).toHaveLength(0);
      hooks.afterRecall = async () => {
        await pool.query(
          "UPDATE procedure_memory_grants SET revoked_at=clock_timestamp() WHERE id=$1",
          [grantId],
        );
      };
      expect(
        (
          await verifyProcedureProvenance(input, {
            ...deps,
            recall: (q) => fresh.recall(q),
          })
        ).status,
      ).toBe("blocked");
      const rejected = await publishProcedureProvenance(claim, {
        ...deps,
        remember: (r) => fresh.remember(r),
      });
      expect(rejected.status).toBe("blocked");
      expect(writes).toBe(1);
      expect(keys).toHaveLength(1);
      fresh.destroy();
      personal.destroy();
    });
  },
);

