import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { researchInputSchema, type ResearchInput } from "./research-inputs";
import {
  researchEnvelopeSchema,
  type ResearchEnvelope,
} from "../../domain/src/strengthening-contracts";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
export async function enqueueResearchJob(
  pool: Pool,
  input: {
    ownerId: string;
    kind: string;
    operationKey: string;
    payload: ResearchEnvelope;
  },
) {
  const payload = researchEnvelopeSchema.parse(input.payload);
  if (input.ownerId !== payload.ownerId) throw Error("RESEARCH_OWNER_MISMATCH");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.kind) || !input.operationKey.trim())
    throw Error("INVALID_RESEARCH_OPERATION");
  const digest = hash(payload);
  const r = await pool.query(
    `INSERT INTO research_jobs(id,user_id,namespace,kind,operation_key,payload,payload_hash)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,namespace,kind,operation_key) DO UPDATE
 SET operation_key=research_jobs.operation_key RETURNING id,payload_hash`,
    [
      payload.jobId,
      input.ownerId,
      payload.namespace,
      input.kind,
      input.operationKey,
      payload,
      digest,
    ],
  );
  if (r.rows[0].payload_hash !== digest)
    throw Error("RESEARCH_IDEMPOTENCY_CONFLICT");
  return r.rows[0].id as string;
}
export async function claimResearchJob(
  pool: Pool,
  input: {
    ownerId: string;
    kind: string;
    leaseSeconds: number;
    jobId?: string;
  },
) {
  if (
    !input.ownerId ||
    !input.kind ||
    !Number.isInteger(input.leaseSeconds) ||
    input.leaseSeconds < 10 ||
    input.leaseSeconds > 300
  )
    throw Error("INVALID_RESEARCH_LEASE");
  await pool.query(
    `UPDATE research_jobs SET state='failed',error_code='ATTEMPTS_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE user_id=$1 AND kind=$2 AND attempts>=3 AND state='processing' AND lease_until<clock_timestamp()`,
    [input.ownerId, input.kind],
  );
  const token = randomUUID();
  const r = await pool.query(
    `UPDATE research_jobs SET state='processing',attempts=attempts+1,lease_token=$1,lease_until=clock_timestamp()+$2*interval '1 second'
 WHERE id=(SELECT id FROM research_jobs WHERE user_id=$3 AND kind=$4 AND ($5::text IS NULL OR id=$5) AND attempts<3
 AND ((state IN ('pending','retry') AND (retry_at IS NULL OR retry_at<=clock_timestamp())) OR (state='processing' AND lease_until<clock_timestamp()))
 ORDER BY recorded_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    [token, input.leaseSeconds, input.ownerId, input.kind, input.jobId ?? null],
  );
  return r.rows[0] ?? null;
}
export async function finishResearchJob(
  pool: Pool,
  input: {
    id: string;
    ownerId: string;
    token: string;
    result: Record<string, unknown>;
  },
) {
  const digest = hash(input.result);
  const r = await pool.query(
    `UPDATE research_jobs SET state='completed',result=$4,result_hash=$5,lease_until=NULL
 WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND ((state='processing' AND lease_until>clock_timestamp()) OR (state='completed' AND result_hash=$5)) RETURNING id`,
    [input.id, input.ownerId, input.token, input.result, digest],
  );
  if (!r.rowCount) throw Error("RESEARCH_LEASE_OR_RESULT_CONFLICT");
}
export async function failResearchJob(
  pool: Pool,
  input: { id: string; ownerId: string; token: string; code: string },
) {
  if (!/^[A-Z0-9_]{1,80}$/.test(input.code))
    throw Error("INVALID_RESEARCH_ERROR_CODE");
  const r = await pool.query(
    `UPDATE research_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'retry' END,
 error_code=$4,retry_at=clock_timestamp()+power(2,attempts)*interval '10 seconds',lease_token=NULL,lease_until=NULL
 WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND state='processing' AND lease_until>clock_timestamp() RETURNING id`,
    [input.id, input.ownerId, input.token, input.code],
  );
  if (!r.rowCount) throw Error("RESEARCH_LEASE_CONFLICT");
}

/** Immutable typed artifacts are committed atomically with their envelope. */
export async function enqueueTypedResearchJob(
  pool: Pool,
  input: {
    ownerId: string;
    operationKey: string;
    payload: ResearchEnvelope;
    artifact: ResearchInput;
    deadlineAt: string;
  },
) {
  const artifact = researchInputSchema.parse(input.artifact);
  if (Buffer.byteLength(JSON.stringify(artifact)) > 900000)
    throw Error("RESEARCH_INPUT_LIMIT");
  if (!Number.isFinite(Date.parse(input.deadlineAt)))
    throw Error("INVALID_RESEARCH_DEADLINE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = await enqueueResearchJob(client as unknown as Pool, {
      ...input,
      kind: artifact.operation,
    });
    const digest = hash({
      artifact,
      deadlineAt: new Date(input.deadlineAt).toISOString(),
    });
    const result = await client.query(
      `INSERT INTO research_job_inputs(job_id,user_id,operation,artifact,artifact_hash)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id) DO UPDATE SET job_id=research_job_inputs.job_id RETURNING artifact_hash`,
      [id, input.ownerId, artifact.operation, artifact, digest],
    );
    if (result.rows[0].artifact_hash !== digest)
      throw Error("RESEARCH_INPUT_IDEMPOTENCY_CONFLICT");
    await client.query("UPDATE research_jobs SET deadline_at=$2 WHERE id=$1", [
      id,
      input.deadlineAt,
    ]);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Per-owner quota reservation and lease claim share a transaction and lock. */
export async function claimTypedResearchJob(
  pool: Pool,
  input: { ownerId: string; dailyQuota: number; leaseSeconds: number },
) {
  if (
    !input.ownerId ||
    !Number.isInteger(input.dailyQuota) ||
    input.dailyQuota < 1 ||
    input.dailyQuota > 1000 ||
    !Number.isInteger(input.leaseSeconds) ||
    input.leaseSeconds < 10 ||
    input.leaseSeconds > 300
  )
    throw Error("INVALID_RESEARCH_LEASE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `research:${input.ownerId}`,
    ]);
    await client.query(
      `UPDATE research_jobs SET state='failed',error_code=CASE WHEN deadline_at<=clock_timestamp() THEN 'DEADLINE_EXCEEDED' ELSE 'ATTEMPTS_EXHAUSTED' END,lease_token=NULL,lease_until=NULL
      WHERE user_id=$1 AND state IN ('pending','retry','processing') AND (deadline_at<=clock_timestamp() OR (attempts>=3 AND state='processing' AND lease_until<clock_timestamp()))`,
      [input.ownerId],
    );
    const usage = await client.query(
      `SELECT jobs FROM research_worker_daily_usage WHERE user_id=$1 AND usage_date=(clock_timestamp() AT TIME ZONE 'UTC')::date`,
      [input.ownerId],
    );
    if ((usage.rows[0]?.jobs ?? 0) >= input.dailyQuota) {
      await client.query("COMMIT");
      return null;
    }
    const token = randomUUID();
    const claimed = await client.query(
      `UPDATE research_jobs SET state='processing',attempts=attempts+1,lease_token=$2,lease_until=LEAST(deadline_at,clock_timestamp()+$3*interval '1 second')
      WHERE id=(SELECT j.id FROM research_jobs j JOIN research_job_inputs i ON i.job_id=j.id AND i.user_id=j.user_id AND i.operation=j.kind
      WHERE j.user_id=$1 AND j.attempts<3 AND j.deadline_at>clock_timestamp()+interval '5 seconds'
      AND ((j.state IN ('pending','retry') AND (j.retry_at IS NULL OR j.retry_at<=clock_timestamp())) OR (j.state='processing' AND j.lease_until<clock_timestamp()))
      ORDER BY j.deadline_at,j.recorded_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING *`,
      [input.ownerId, token, input.leaseSeconds],
    );
    const job = claimed.rows[0];
    if (job) {
      const artifact = await client.query(
        "SELECT artifact FROM research_job_inputs WHERE job_id=$1 AND user_id=$2",
        [job.id, input.ownerId],
      );
      job.artifact = artifact.rows[0].artifact;
      await client.query(
        `INSERT INTO research_worker_daily_usage(user_id,usage_date,jobs) VALUES($1,(clock_timestamp() AT TIME ZONE 'UTC')::date,1)
        ON CONFLICT(user_id,usage_date) DO UPDATE SET jobs=research_worker_daily_usage.jobs+1`,
        [input.ownerId],
      );
    }
    await client.query("COMMIT");
    return job ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
