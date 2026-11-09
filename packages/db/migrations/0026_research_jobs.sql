CREATE TABLE research_jobs (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 namespace text NOT NULL,kind text NOT NULL,operation_key text NOT NULL,
 payload jsonb NOT NULL,payload_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','retry','completed','failed')),
 attempts integer NOT NULL DEFAULT 0,lease_token text,lease_until timestamptz,
 retry_at timestamptz,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 result jsonb,result_hash text,error_code text,
 UNIQUE(user_id,namespace,kind,operation_key)
);
CREATE INDEX research_jobs_due ON research_jobs(state,retry_at,recorded_at);
