CREATE TABLE procedure_memory_grants (
 id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), procedure_id text NOT NULL REFERENCES procedure_versions(id),
 procedure_hash text NOT NULL CHECK(procedure_hash ~ '^[a-f0-9]{64}$'),
 namespace_kind text NOT NULL CHECK(namespace_kind='evaluation'),
 consent_evidence_ref text NOT NULL CHECK(length(consent_evidence_ref)>0),
 consented_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(revoked_at IS NULL OR revoked_at>=consented_at)
);
-- Explicit owner consent is separate from personal memory consent and operator review authority.
-- Neither the publication CLI nor a model tool can create this grant.
CREATE TABLE procedure_memory_publications (
 id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id),
 grant_id text NOT NULL REFERENCES procedure_memory_grants(id),
 procedure_id text NOT NULL REFERENCES procedure_versions(id),
 reviewer_id text NOT NULL REFERENCES users(id),
 record jsonb NOT NULL, record_hash text NOT NULL CHECK(record_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','retry','verified','blocked')),
 attempts integer NOT NULL DEFAULT 0,lease_until timestamptz,retry_at timestamptz,
 receipt jsonb,fresh_verified_at timestamptz,error_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,procedure_id,grant_id)
);
CREATE FUNCTION protect_procedure_memory_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.owner_id,NEW.grant_id,NEW.procedure_id,NEW.reviewer_id,NEW.record,NEW.record_hash,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.grant_id,OLD.procedure_id,OLD.reviewer_id,OLD.record,OLD.record_hash,OLD.created_at)
 THEN RAISE EXCEPTION 'PROCEDURE_MEMORY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER procedure_memory_immutable BEFORE UPDATE ON procedure_memory_publications FOR EACH ROW EXECUTE FUNCTION protect_procedure_memory_immutable();
