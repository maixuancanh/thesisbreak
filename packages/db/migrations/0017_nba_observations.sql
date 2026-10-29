CREATE TABLE nba_public_snapshots (
 id text PRIMARY KEY,
 source_url text NOT NULL,
 retrieved_at timestamptz NOT NULL,
 content_hash text NOT NULL,
 payload jsonb NOT NULL,
 UNIQUE(source_url,content_hash)
);
CREATE INDEX nba_public_snapshots_recent ON nba_public_snapshots(retrieved_at DESC);
