import { claimLearningJob } from "../../db/src/learning-jobs";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  buildRunDossier,
  refreshRunDossier,
} from "../../agent/src/dossier-builder";
import {
  readEventDossier,
  syncDossierDependency,
} from "../../db/src/event-dossier";
/** A bounded materialized view of actual run facts; no model can edit confirmed decisions. */
export async function runOneEventDossierJob(pool: Pool, ownerId?: string) {
  const token = randomUUID();
  const job = await claimLearningJob(pool, {
    kinds: ["dossier_refresh", "dossier_dependency_change"],
    token,
    leaseSeconds: 60,
    ownerId,
  });
  if (!job) return { checked: 0, completed: 0 };
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (job.kind === "dossier_dependency_change") {
      const eventId = String(job.payload.eventId);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `dossier:${job.user_id}:${eventId}`,
      ]);
      await syncDossierDependency(c, job.user_id, eventId, {
        id: job.payload.dependencyId,
        version: job.payload.version,
        hash: job.payload.hash,
        status: job.payload.status,
      });
    } else {
      const run = (
        await c.query(
          `SELECT r.*,v.memory_consent FROM agent_runs r JOIN conversations v ON v.id=r.conversation_id AND v.user_id=r.user_id WHERE r.id=$1 AND r.user_id=$2 AND r.status='completed' FOR SHARE OF v`,
          [job.payload.runId, job.user_id],
        )
      ).rows[0];
      if (run?.memory_consent === true) {
        const next = buildRunDossier(
          job.user_id,
          run.result,
          new Date(run.finished_at).toISOString(),
        );
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `dossier:${job.user_id}:${next.eventId}`,
        ]);
        const old = await readEventDossier(c, job.user_id, next.eventId);
        const refreshed =
          old && Date.parse(old.checkedAt) <= Date.parse(next.checkedAt)
            ? refreshRunDossier(old, job.user_id, run.result, next.checkedAt)
            : null;
        if (!old || refreshed) {
          // Later runs patch only changed derived blocks; confirmed view/rules stay immutable.
          await c.query(
            `INSERT INTO event_dossier_versions(user_id,event_id,revision,payload) VALUES($1,$2,$3,$4)`,
            [
              job.user_id,
              next.eventId,
              (old?.revision ?? 0) + 1,
              JSON.stringify(refreshed?.dossier ?? next),
            ],
          );
        }
      }
    }
    const done = await c.query(
      `UPDATE learning_jobs SET state='completed',lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [job.id, token],
    );
    if (done.rowCount !== 1) throw Error("LEASE_LOST");
    await c.query("COMMIT");
    return { checked: 1, completed: 1 };
  } catch {
    await c.query("ROLLBACK");
    await pool.query(
      `UPDATE learning_jobs SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,lease_until=NULL,retry_at=clock_timestamp()+interval '5 minutes',last_error='DOSSIER_REFRESH_FAILED' WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [job.id, token],
    );
    return { checked: 1, completed: 0 };
  } finally {
    c.release();
  }
}
