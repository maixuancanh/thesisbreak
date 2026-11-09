ALTER TABLE research_artifact_memory_grants ADD COLUMN authority_kind text NOT NULL DEFAULT 'reviewed' CHECK(authority_kind IN ('reviewed','owner'));
ALTER TABLE research_artifact_memory_grants ADD COLUMN consent_evidence jsonb;
CREATE TABLE research_artifact_memory_inspections (
 id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), kind text NOT NULL,
 artifact_id text NOT NULL,snapshot_hash text NOT NULL, inspected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes', grant_id text UNIQUE REFERENCES research_artifact_memory_grants(id)
);
CREATE FUNCTION protect_research_artifact_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
 THEN RAISE EXCEPTION 'RESEARCH_ARTIFACT_GRANT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_artifact_grant_immutable BEFORE UPDATE ON research_artifact_memory_grants FOR EACH ROW EXECUTE FUNCTION protect_research_artifact_grant();
