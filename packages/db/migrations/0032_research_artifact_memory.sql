-- Grants are written only by a trusted consent workflow, never by the publication worker/CLI.
CREATE TABLE research_artifact_memory_grants (
 id text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('source_change','forecast_rationale','forecast_result','drift_summary')),
 artifact_id text NOT NULL,snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
 namespace_kind text NOT NULL CHECK(namespace_kind='evaluation'),
 consent_evidence_ref text NOT NULL CHECK(length(trim(consent_evidence_ref))>0),
 consented_at timestamptz NOT NULL,revoked_at timestamptz,
 CHECK(revoked_at IS NULL OR revoked_at>=consented_at)
);
CREATE TABLE research_artifact_memory_publications (
 id text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),reviewer_id text NOT NULL REFERENCES users(id),
 grant_id text NOT NULL REFERENCES research_artifact_memory_grants(id),
 kind text NOT NULL,artifact_id text NOT NULL,record jsonb NOT NULL,record_hash text NOT NULL,
 snapshot_hash text NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','retry','verified','blocked')),
 attempts integer NOT NULL DEFAULT 0,lease_token text,lease_until timestamptz,retry_at timestamptz,
 receipt jsonb,fresh_verified_at timestamptz,error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,kind,artifact_id,grant_id)
);
CREATE FUNCTION protect_research_artifact_memory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.owner_id,NEW.reviewer_id,NEW.grant_id,NEW.kind,NEW.artifact_id,NEW.record,NEW.record_hash,NEW.snapshot_hash,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.reviewer_id,OLD.grant_id,OLD.kind,OLD.artifact_id,OLD.record,OLD.record_hash,OLD.snapshot_hash,OLD.created_at)
 THEN RAISE EXCEPTION 'RESEARCH_ARTIFACT_MEMORY_IMMUTABLE'; END IF;
 IF OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt THEN RAISE EXCEPTION 'RESEARCH_ARTIFACT_RECEIPT_IMMUTABLE'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER research_artifact_memory_immutable BEFORE UPDATE ON research_artifact_memory_publications FOR EACH ROW EXECUTE FUNCTION protect_research_artifact_memory();
