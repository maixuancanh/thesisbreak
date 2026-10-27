CREATE TABLE provider_public_cache (
 provider text NOT NULL,
 query_key text NOT NULL,
 payload jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(provider, query_key)
);
CREATE INDEX provider_public_cache_expiry_idx ON provider_public_cache(expires_at);
