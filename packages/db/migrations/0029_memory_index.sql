-- Rebuildable derived data. No content here grants memory authority.
CREATE TABLE memory_index_edges (
 owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 namespace text NOT NULL, edge_id text NOT NULL,
 memory_id text NOT NULL, memory_version integer NOT NULL CHECK(memory_version>0),
 memory_sha256 text NOT NULL CHECK(memory_sha256 ~ '^[a-f0-9]{64}$'), blob_id text NOT NULL,
 event_provider text NOT NULL,event_native_id text NOT NULL,event_date date NOT NULL,
 recorded_at timestamptz NOT NULL,available_at timestamptz NOT NULL,
 valid_from timestamptz NOT NULL,valid_to timestamptz,
 trusted boolean NOT NULL DEFAULT false,
 edge jsonb NOT NULL,
 indexed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,namespace,edge_id),
 CHECK(valid_to IS NULL OR valid_to>valid_from),
 CHECK(edge->'pointer'->>'ownerId'=owner_id),
 CHECK(edge->>'namespace'=namespace), CHECK(edge->>'id'=edge_id)
);
CREATE INDEX memory_index_scope ON memory_index_edges(owner_id,namespace,event_provider,event_native_id,event_date,available_at) WHERE trusted;
CREATE INDEX memory_index_pointer ON memory_index_edges(owner_id,namespace,memory_id,memory_version);
