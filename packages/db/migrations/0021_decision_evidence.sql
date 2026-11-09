CREATE TABLE event_dossier_versions (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,event_id text NOT NULL,revision integer NOT NULL CHECK(revision>0),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=200000),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,event_id,revision)
);
CREATE TABLE decision_dependencies (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,decision_id text NOT NULL,event_id text NOT NULL,
 dependency_id text NOT NULL,dependency_version integer NOT NULL CHECK(dependency_version>0),dependency_hash text NOT NULL,
 dependency_status text NOT NULL CHECK(dependency_status IN ('current','false','superseded','revoked','unavailable','broken','pending_consolidation')),
 monitoring boolean NOT NULL,consent boolean NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,decision_id,dependency_id)
);
CREATE INDEX decision_dependencies_lookup ON decision_dependencies(user_id,dependency_id) WHERE monitoring AND consent;
CREATE TABLE decision_receipts (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,id text NOT NULL,event_id text NOT NULL,payload jsonb NOT NULL CHECK(octet_length(payload::text)<=200000),
 payload_hash text NOT NULL,publication_state text NOT NULL DEFAULT 'pending' CHECK(publication_state IN ('not_requested','pending','published','verified','failed')),
 record_id text,readback_hash text,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(user_id,id)
);
