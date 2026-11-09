CREATE TABLE source_profiles (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_id text NOT NULL, source_name text NOT NULL, kind text NOT NULL CHECK (kind IN ('market_baseline','user_reported_forecaster')),
 cohort text NOT NULL, state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused')),
 memory_consent boolean NOT NULL, current_version integer NOT NULL DEFAULT 0 CHECK (current_version>=0),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id),UNIQUE(user_id,source_id,cohort)
);
--> statement-breakpoint
CREATE TABLE source_forecasts (
 id text PRIMARY KEY,profile_id text NOT NULL,user_id text NOT NULL,platform text NOT NULL CHECK (platform IN ('kalshi','polymarket')),native_id text NOT NULL,
 outcome text NOT NULL,probability jsonb,baseline_probability jsonb,scheduled_at timestamptz,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),reference text NOT NULL,rules_hash text NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK (revision>0),resolution jsonb,
 FOREIGN KEY(profile_id,user_id) REFERENCES source_profiles(id,user_id) ON DELETE CASCADE,UNIQUE(profile_id,platform,native_id)
);
--> statement-breakpoint
CREATE INDEX source_forecasts_market_idx ON source_forecasts(platform,native_id);
--> statement-breakpoint
CREATE TABLE source_score_versions (
 profile_id text NOT NULL,user_id text NOT NULL,version integer NOT NULL CHECK (version>0),payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(profile_id,version),FOREIGN KEY(profile_id,user_id) REFERENCES source_profiles(id,user_id) ON DELETE CASCADE
);
