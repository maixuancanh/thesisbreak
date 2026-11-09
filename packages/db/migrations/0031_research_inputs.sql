CREATE TABLE research_job_inputs (
 job_id text PRIMARY KEY REFERENCES research_jobs(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 operation text NOT NULL CHECK(operation IN ('calibration','online_learning','procedure_evaluate')),
 artifact jsonb NOT NULL, artifact_hash text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(octet_length(artifact::text)<=1000000)
);
ALTER TABLE research_jobs ADD COLUMN deadline_at timestamptz;
CREATE TABLE research_worker_daily_usage (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 usage_date date NOT NULL, jobs integer NOT NULL CHECK(jobs>=0), PRIMARY KEY(user_id,usage_date)
);
CREATE TABLE research_worker_health (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 last_started_at timestamptz,last_success_at timestamptz,last_failed_at timestamptz,summary jsonb
);
