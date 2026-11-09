ALTER TABLE source_forecasts ADD COLUMN scope jsonb;
CREATE TABLE source_fact_reviews (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 profile_id text NOT NULL REFERENCES source_profiles(id) ON DELETE CASCADE,
 claim text NOT NULL,
 source_reference text NOT NULL,
 evidence_reference text NOT NULL,
 verdict text NOT NULL CHECK(verdict IN ('supported','refuted','unclear')),
 scope jsonb NOT NULL,
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_id text NOT NULL,
 request_hash text NOT NULL,
 UNIQUE(user_id,request_id)
);
CREATE TABLE confirmed_action_results (
 pick_id text NOT NULL REFERENCES picks(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 revision integer NOT NULL,
 payload jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(pick_id,revision)
);
CREATE TABLE action_memory_preferences(user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,memory_consent boolean NOT NULL DEFAULT false);
CREATE TABLE action_memory_receipts(pick_id text NOT NULL REFERENCES picks(id) ON DELETE CASCADE,revision integer NOT NULL,blob_id text NOT NULL,hash text NOT NULL,PRIMARY KEY(pick_id,revision));
