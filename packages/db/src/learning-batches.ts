import type { Pool } from "pg";
/** Same-owner/session/event originals only. Group membership commits before any remote extraction. */
export async function prepareLearningBatch(
  pool: Pool,
  job: { id: string; user_id: string; payload: Record<string, unknown> },
  token: string,
  idleSeconds = 120,
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const locked = (
      await c.query(
        "SELECT * FROM learning_jobs WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND state='processing' AND lease_until>clock_timestamp() FOR UPDATE",
        [job.id, job.user_id, token],
      )
    ).rows[0];
    if (!locked) throw Error("LEARNING_LEASE_LOST");
    const source = (
      await c.query(
        `SELECT e.*,co.updated_at,co.memory_consent,clock_timestamp() AS known_at,co.updated_at+($3*interval '1 second')<=clock_timestamp() AS idle FROM learning_experiences e JOIN conversations co ON co.id=e.session_id AND co.user_id=e.user_id WHERE e.user_id=$1 AND e.id=$2 FOR SHARE OF co`,
        [job.user_id, locked.payload.id, idleSeconds],
      )
    ).rows[0];
    if (!source || !source.memory_consent) {
      await c.query("COMMIT");
      return { deferred: false, rows: [] };
    }
    let ids: string[] = locked.payload.batchExperienceIds ?? [source.id];
    if (
      !locked.payload.batchExperienceIds &&
      !locked.payload.extraction &&
      !locked.payload.immediate
    ) {
      if (!source.idle) {
        await c.query(
          "UPDATE learning_jobs SET state='retry',attempts=GREATEST(0,attempts-1),retry_at=$3::timestamptz+($4*interval '1 second'),lease_until=NULL,last_error='SESSION_NOT_IDLE' WHERE id=$1 AND lease_token=$2",
          [job.id, token, source.updated_at, idleSeconds],
        );
        await c.query("COMMIT");
        return { deferred: true, rows: [] };
      }
      const siblings = (
        await c.query(
          `SELECT j.id,e.id AS experience_id FROM learning_jobs j JOIN learning_experiences e ON e.user_id=j.user_id AND e.id=j.payload->>'id' WHERE j.user_id=$1 AND j.kind='extract' AND j.id<>$2 AND j.state IN ('pending','retry') AND NOT COALESCE((j.payload->>'immediate')::boolean,false) AND NOT(j.payload ? 'batchExperienceIds') AND e.session_id=$3 AND e.event_id=$4 ORDER BY e.recorded_at,e.id LIMIT 3 FOR UPDATE OF j SKIP LOCKED`,
          [job.user_id, job.id, source.session_id, source.event_id],
        )
      ).rows;
      ids = [source.id, ...siblings.map((r) => r.experience_id)];
      await c.query(
        "UPDATE learning_jobs SET payload=payload||jsonb_build_object('batchExperienceIds',$3::jsonb,'batchedJobIds',$4::jsonb) WHERE id=$1 AND lease_token=$2",
        [
          job.id,
          token,
          JSON.stringify(ids),
          JSON.stringify(siblings.map((r) => r.id)),
        ],
      );
      if (siblings.length)
        await c.query(
          "UPDATE learning_jobs SET state='completed',last_error='BATCHED_IN_PRIMARY',payload=payload||jsonb_build_object('batchedInto',$2::text),lease_until=NULL WHERE user_id=$1 AND id=ANY($3)",
          [job.user_id, job.id, siblings.map((r) => r.id)],
        );
    }
    if (ids.length > 4) throw Error("INVALID_BATCH_MEMBERSHIP");
    const rows = (
      await c.query(
        "SELECT e.*,clock_timestamp() AS known_at FROM learning_experiences e WHERE e.user_id=$1 AND e.id=ANY($2) ORDER BY e.recorded_at,e.id",
        [job.user_id, ids],
      )
    ).rows;
    if (
      rows.length !== new Set(ids).size ||
      rows.some(
        (r) =>
          r.session_id !== source.session_id || r.event_id !== source.event_id,
      )
    )
      throw Error("INVALID_BATCH_MEMBERSHIP");
    await c.query("COMMIT");
    return { deferred: false, rows };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
