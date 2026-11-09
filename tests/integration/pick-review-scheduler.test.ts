import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { claimLearningJob } from "../../packages/db/src/learning-jobs";
import {
  nextMaintenancePhase,
  MAINTENANCE_PHASES,
} from "../../packages/integrations/src/forecast-maintenance";
it("durable phase SQL follows the phase list length", async () => {
  const sql: string[] = [];
  const phase = await nextMaintenancePhase({
    query: async (q: string) => {
      sql.push(q);
      return { rows: [{ next: 1 }] };
    },
  } as unknown as Pick<Pool, "query">);
  expect(phase).toBe(MAINTENANCE_PHASES[0]);
  expect(sql[0]).toContain(`%${MAINTENANCE_PHASES.length}`);
});
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "100-job bounded fair queue and lease recovery",
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
      await pool.query(
        `INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) SELECT gen_random_uuid()::text,$1,'decision_recap','load:'||i,jsonb_build_object('pickId','fixture-'||i) FROM generate_series(1,100)i`,
        [owner],
      );
      await pool.query(
        "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'decision_recap','other','{}')",
        [randomUUID(), other],
      );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
      await pool.end();
    });
    it("claims exactly one per invocation, respects owner fence and reclaims expired lease", async () => {
      const first = await claimLearningJob(pool, {
        kinds: ["decision_recap"],
        token: "first",
        leaseSeconds: 10,
        ownerId: owner,
      });
      expect(first?.user_id).toBe(owner);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM learning_jobs WHERE user_id=$1 AND state='processing'",
            [owner],
          )
        ).rows[0].n,
      ).toBe(1);
      await pool.query(
        "UPDATE learning_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [first.id],
      );
      const reclaimed = await claimLearningJob(pool, {
        kinds: ["decision_recap"],
        token: "second",
        leaseSeconds: 10,
        ownerId: owner,
      });
      expect(reclaimed.id).toBe(first.id);
      expect(reclaimed.attempts).toBe(2);
      expect(
        (
          await pool.query("SELECT state FROM learning_jobs WHERE user_id=$1", [
            other,
          ])
        ).rows[0].state,
      ).toBe("pending");
    });
  },
);
