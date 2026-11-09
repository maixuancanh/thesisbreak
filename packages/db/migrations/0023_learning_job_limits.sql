ALTER TABLE learning_jobs ADD COLUMN claimed_at timestamptz;
CREATE INDEX learning_jobs_owner_claimed ON learning_jobs(user_id,claimed_at DESC);
CREATE INDEX learning_jobs_kind_claimed ON learning_jobs(kind,claimed_at DESC);
