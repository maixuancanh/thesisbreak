CREATE TABLE nba_forecasts (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 namespace text NOT NULL CHECK(namespace='live' OR namespace ~ '^replay:[A-Za-z0-9_-]+$'),
 event_id text NOT NULL,
 horizon text NOT NULL CHECK(horizon IN ('T24h','T60m')),
 method_version text NOT NULL,
 scheduled_at timestamptz NOT NULL,
 captured_at timestamptz NOT NULL,
 payload jsonb NOT NULL,
 request_hash text NOT NULL,
 memory_consent boolean NOT NULL DEFAULT false,
 UNIQUE(user_id,namespace,event_id,horizon,method_version),
 CHECK(captured_at<scheduled_at)
);
--> statement-breakpoint
CREATE FUNCTION nba_forecast_capture_clock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.namespace='live' THEN NEW.captured_at=clock_timestamp(); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER nba_forecast_clock BEFORE INSERT ON nba_forecasts FOR EACH ROW EXECUTE FUNCTION nba_forecast_capture_clock();
--> statement-breakpoint
CREATE FUNCTION nba_forecast_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_FORECAST'; END $$;
--> statement-breakpoint
CREATE TRIGGER nba_forecast_no_update BEFORE UPDATE ON nba_forecasts FOR EACH ROW EXECUTE FUNCTION nba_forecast_immutable();
--> statement-breakpoint
CREATE TABLE nba_forecast_results (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 namespace text NOT NULL CHECK(namespace='live' OR namespace ~ '^replay:[A-Za-z0-9_-]+$'),
 event_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 payload jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,namespace,event_id,revision)
);
--> statement-breakpoint
CREATE TRIGGER nba_result_no_update BEFORE UPDATE ON nba_forecast_results FOR EACH ROW EXECUTE FUNCTION nba_forecast_immutable();
--> statement-breakpoint
CREATE TABLE nba_forecast_memory_receipts (
 forecast_id text PRIMARY KEY REFERENCES nba_forecasts(id) ON DELETE CASCADE,
 blob_id text NOT NULL,
 hash text NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
