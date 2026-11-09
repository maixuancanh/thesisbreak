ALTER TABLE nba_forecast_subscriptions ADD COLUMN challenger_consent boolean NOT NULL DEFAULT false;
CREATE TABLE nba_challenger_jobs (
 id text PRIMARY KEY,
 forecast_id text NOT NULL UNIQUE REFERENCES nba_forecasts(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','completed','failed','unavailable')),
 envelope jsonb, artifacts jsonb, result jsonb, error_code text,
 model_version text NOT NULL, procedure_version text NOT NULL,
 lease_token text, lease_until timestamptz,
 reserved_calls integer NOT NULL DEFAULT 0 CHECK(reserved_calls IN (0,3)),
 reserved_tokens integer NOT NULL DEFAULT 0 CHECK(reserved_tokens BETWEEN 0 AND 3000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 CHECK((state='completed')=(result IS NOT NULL))
);
CREATE TABLE nba_challenger_daily_usage (
 scope text NOT NULL, usage_date date NOT NULL,
 calls integer NOT NULL CHECK(calls>=0), tokens integer NOT NULL CHECK(tokens>=0),
 PRIMARY KEY(scope,usage_date)
);
CREATE FUNCTION protect_nba_challenger_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.forecast_id,NEW.user_id,NEW.model_version,NEW.procedure_version,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.forecast_id,OLD.user_id,OLD.model_version,OLD.procedure_version,OLD.created_at)
 OR (OLD.envelope IS NOT NULL AND ROW(NEW.envelope,NEW.artifacts) IS DISTINCT FROM ROW(OLD.envelope,OLD.artifacts))
 OR OLD.state IN ('completed','failed','unavailable')
 OR (OLD.reserved_calls>0 AND ROW(NEW.reserved_calls,NEW.reserved_tokens) IS DISTINCT FROM ROW(OLD.reserved_calls,OLD.reserved_tokens))
 THEN RAISE EXCEPTION 'IMMUTABLE_CHALLENGER_JOB'; END IF;
 IF NEW.state='completed' THEN
   NEW.completed_at=clock_timestamp();
   IF NEW.completed_at >= (SELECT scheduled_at FROM nba_forecasts WHERE id=NEW.forecast_id)
   THEN RAISE EXCEPTION 'CHALLENGER_COMPLETED_LATE'; END IF;
   NEW.result=jsonb_set(NEW.result,'{completedAt}',to_jsonb(NEW.completed_at));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER nba_challenger_job_immutable BEFORE UPDATE ON nba_challenger_jobs FOR EACH ROW EXECUTE FUNCTION protect_nba_challenger_job();
