import type { Pool } from "pg";
/** Short serialized scheduling transaction gives backlogged owners/kinds turns without holding a lock during work. */
export async function claimLearningJob(
  pool: Pool,
  input: {
    kinds: string[];
    token: string;
    leaseSeconds: number;
    ownerId?: string | undefined;
  },
) {
  if (
    !input.kinds.length ||
    input.kinds.length > 10 ||
    !Number.isInteger(input.leaseSeconds) ||
    input.leaseSeconds < 10 ||
    input.leaseSeconds > 300
  )
    throw Error("INVALID_LEARNING_CLAIM");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('learning-job-fair-scheduler',0))",
    );
    const row = (
      await c.query(
        `UPDATE learning_jobs SET state='processing',lease_token=$1,lease_until=clock_timestamp()+$2*interval '1 second',claimed_at=clock_timestamp(),attempts=attempts+1
 WHERE id=(SELECT j.id FROM learning_jobs j WHERE j.kind=ANY($3) AND ($4::text IS NULL OR j.user_id=$4) AND j.attempts<5
 AND ((j.state IN ('pending','retry') AND (j.retry_at IS NULL OR j.retry_at<=clock_timestamp())) OR (j.state='processing' AND j.lease_until<clock_timestamp()))
 ORDER BY (SELECT max(x.claimed_at) FROM learning_jobs x WHERE x.user_id=j.user_id) ASC NULLS FIRST,
 (SELECT max(x.claimed_at) FROM learning_jobs x WHERE x.kind=j.kind) ASC NULLS FIRST,j.recorded_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING *`,
        [input.token, input.leaseSeconds, input.kinds, input.ownerId ?? null],
      )
    ).rows[0];
    await c.query("COMMIT");
    return row ?? null;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
