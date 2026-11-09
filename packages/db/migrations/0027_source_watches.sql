CREATE TABLE source_watches (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_id text NOT NULL,url text NOT NULL,origin_id text NOT NULL,content_class text NOT NULL CHECK(content_class IN ('json','feed','html')),
 selector text NOT NULL,dependency_id text NOT NULL,hypothesis_version integer NOT NULL CHECK(hypothesis_version>0),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','deleted')),
 expires_at timestamptz NOT NULL,poll_seconds integer NOT NULL CHECK(poll_seconds BETWEEN 300 AND 86400),
 next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_success_at timestamptz,last_error text,
 snapshot_hash text,snapshot_value text,published_at timestamptz,sequence integer NOT NULL DEFAULT 0,
 service_watch_id text UNIQUE,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX source_watch_due ON source_watches(next_check_at) WHERE state='active';
CREATE TABLE source_change_events (
 id text PRIMARY KEY,watch_id text NOT NULL REFERENCES source_watches(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,before_hash text NOT NULL,after_hash text NOT NULL,
 sequence integer NOT NULL,before_value text NOT NULL,after_value text NOT NULL,
 published_at timestamptz,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(watch_id,before_hash,after_hash,sequence),UNIQUE(watch_id,sequence)
);
CREATE TABLE source_watch_nonces (
 nonce text PRIMARY KEY,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE source_watch_daily_budget (
 day date PRIMARY KEY,checks integer NOT NULL CHECK(checks>0)
);
