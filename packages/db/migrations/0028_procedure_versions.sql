CREATE TABLE procedure_reviewer_authorizations (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz
);
-- Provisioning this table is an operator action; no self-service reviewer endpoint exists.
CREATE TABLE procedure_versions (
 id text PRIMARY KEY, parent_id text REFERENCES procedure_versions(id), parent_hash text,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), content jsonb NOT NULL,
 corpus_version text NOT NULL, failure_example_ids jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','evaluated','rejected','approved','active','retired')),
 evaluation jsonb, reviewer_id text REFERENCES users(id), reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((parent_id IS NULL) = (parent_hash IS NULL)),
 CHECK (status NOT IN ('approved','active','retired') OR (reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL AND evaluation IS NOT NULL))
);
CREATE UNIQUE INDEX procedure_only_one_active ON procedure_versions((status)) WHERE status='active';
CREATE TABLE procedure_active_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), active_id text REFERENCES procedure_versions(id), revision integer NOT NULL DEFAULT 0
);
INSERT INTO procedure_active_state(singleton) VALUES(true);
CREATE TABLE procedure_reviews (
 id bigserial PRIMARY KEY, version_id text NOT NULL REFERENCES procedure_versions(id),
 reviewer_id text NOT NULL REFERENCES users(id), action text NOT NULL CHECK(action IN ('evaluate','approve','reject','activate','rollback')),
 previous_active_id text REFERENCES procedure_versions(id), reason text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION protect_procedure_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.parent_id,NEW.parent_hash,NEW.content_hash,NEW.content,NEW.corpus_version,NEW.failure_example_ids,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.parent_id,OLD.parent_hash,OLD.content_hash,OLD.content,OLD.corpus_version,OLD.failure_example_ids,OLD.created_at) THEN
 RAISE EXCEPTION 'PROCEDURE_CONTENT_IMMUTABLE'; END IF;
 IF OLD.evaluation IS NOT NULL AND NEW.evaluation IS DISTINCT FROM OLD.evaluation THEN RAISE EXCEPTION 'PROCEDURE_EVALUATION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER procedure_immutable BEFORE UPDATE ON procedure_versions FOR EACH ROW EXECUTE FUNCTION protect_procedure_immutable();
