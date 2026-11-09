import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  saveProcedureDraft,
  sealProcedureEvaluation,
  reviewProcedureCandidate,
  promoteProcedure,
  getActiveProcedure,
} from "../../packages/db/src/procedure-versions";
import {
  createProcedureVersion,
  type ProcedureVersion,
} from "../../packages/domain/src/procedure-version";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "procedure promotion authority and concurrency",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const reviewer = randomUUID(),
      ordinary = randomUUID(),
      ids: string[] = [];
    let original: ProcedureVersion | null = null;
    let lock: PoolClient;
    const report = {
      reportHash: "b".repeat(64),
      corpusVersion: "test",
      criticalViolations: [],
      grounding: 1,
      actionCompliance: 1,
      latencyMs: 1,
      costUsd: 0,
      validationPassed: true,
      sealedTestPassed: true,
    };
    beforeAll(async () => {
      lock = await pool.connect();
      await lock.query("SELECT pg_advisory_lock(8671220)");
      original = await getActiveProcedure(pool);
      await pool.query(
        "INSERT INTO users(id,provider_subject) VALUES($1,$1),($2,$2)",
        [reviewer, ordinary],
      );
      await pool.query(
        "INSERT INTO procedure_reviewer_authorizations(user_id) VALUES($1)",
        [reviewer],
      );
    });
    afterAll(async () => {
      // Fixtures only; restore singleton and remove child versions before their parents.
      await pool.query(
        "UPDATE procedure_versions SET status='retired' WHERE id=ANY($1) AND status='active'",
        [ids],
      );
      await pool.query(
        "UPDATE procedure_active_state SET active_id=$1 WHERE singleton=true",
        [original?.id ?? null],
      );
      if (original)
        await pool.query(
          "UPDATE procedure_versions SET status='active' WHERE id=$1",
          [original.id],
        );
      await pool.query(
        "DELETE FROM procedure_reviews WHERE version_id=ANY($1)",
        [ids],
      );
      for (const id of [...ids].reverse())
        await pool.query("DELETE FROM procedure_versions WHERE id=$1", [id]);
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [
        [reviewer, ordinary],
      ]);
      await lock.query("SELECT pg_advisory_unlock(8671220)");
      lock.release();
      await pool.end();
    });
    const make = (parent: ProcedureVersion | null) =>
      createProcedureVersion({
        id: randomUUID(),
        parentId: parent?.id ?? null,
        parentHash: parent?.hash ?? null,
        content: {
          researchInstructions: "Check official",
          queryTemplates: [],
          proposedReadOrder: [],
        },
        corpusVersion: "test",
        failureExampleIds: [],
      });
    const prepare = async (v: ProcedureVersion) => {
      ids.push(v.id);
      await saveProcedureDraft(pool, reviewer, v);
      await sealProcedureEvaluation(pool, reviewer, v.id, report);
      await reviewProcedureCandidate(pool, reviewer, v.id, true);
    };
    it("blocks ordinary users, freezes content, serializes concurrent activation and rolls back", async () => {
      const version = make(original);
      await expect(saveProcedureDraft(pool, ordinary, version)).rejects.toThrow(
        "REVIEWER",
      );
      ids.push(version.id);
      await saveProcedureDraft(pool, reviewer, version);
      await expect(
        pool.query("UPDATE procedure_versions SET content='{}' WHERE id=$1", [
          version.id,
        ]),
      ).rejects.toThrow("IMMUTABLE");
      await sealProcedureEvaluation(pool, reviewer, version.id, report);
      await expect(
        sealProcedureEvaluation(pool, reviewer, version.id, report),
      ).rejects.toThrow("SEALED");
      await expect(
        reviewProcedureCandidate(pool, ordinary, version.id, true),
      ).rejects.toThrow("REVIEWER");
      await reviewProcedureCandidate(pool, reviewer, version.id, true);
      await expect(
        promoteProcedure(pool, {
          reviewerId: reviewer,
          versionId: version.id,
          expectedActiveId: "stale",
          reason: "test",
        }),
      ).rejects.toThrow("STALE");
      await promoteProcedure(pool, {
        reviewerId: reviewer,
        versionId: version.id,
        expectedActiveId: original?.id ?? null,
        reason: "test promotion",
      });
      const active = (await getActiveProcedure(pool))!;
      expect(active.id).toBe(version.id);
      const siblings = [make(active), make(active)];
      for (const v of siblings) await prepare(v);
      const promotions = await Promise.allSettled(
        siblings.map((v) =>
          promoteProcedure(pool, {
            reviewerId: reviewer,
            versionId: v.id,
            expectedActiveId: active.id,
            reason: "concurrent",
          }),
        ),
      );
      expect(promotions.filter((r) => r.status === "fulfilled")).toHaveLength(
        1,
      );
      const winner = (await getActiveProcedure(pool))!;
      await promoteProcedure(pool, {
        reviewerId: reviewer,
        versionId: active.id,
        expectedActiveId: winner.id,
        reason: "rollback",
        rollback: true,
      });
      expect((await getActiveProcedure(pool))!.id).toBe(active.id);
      expect(active.status).toBe("active"); // Existing run snapshot stays immutable.
      const bad = make(active);
      ids.push(bad.id);
      await saveProcedureDraft(pool, reviewer, bad);
      await sealProcedureEvaluation(pool, reviewer, bad.id, {
        ...report,
        criticalViolations: ["confirmation_bypass"],
      });
      await expect(
        reviewProcedureCandidate(pool, reviewer, bad.id, true),
      ).rejects.toThrow("NOT_ELIGIBLE");
    });
  },
);
