ALTER TABLE conversations ALTER COLUMN platform DROP NOT NULL;
ALTER TABLE conversations ALTER COLUMN native_id DROP NOT NULL;
ALTER TABLE conversations ADD COLUMN title text NOT NULL DEFAULT 'New chat';
ALTER TABLE conversations ADD COLUMN memory_consent boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE conversations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE agent_runs ADD COLUMN platform text;
ALTER TABLE agent_runs ADD COLUMN native_id text;
UPDATE agent_runs r SET platform=c.platform,native_id=c.native_id FROM conversations c WHERE c.id=r.conversation_id AND c.user_id=r.user_id;
CREATE TABLE conversation_memories (
 conversation_id text NOT NULL,
 user_id text NOT NULL,
 version integer NOT NULL CHECK(version>0),
 payload jsonb NOT NULL,
 recorded_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','verified','retry')),
 blob_id text,
 hash text,
 attempts integer NOT NULL DEFAULT 0,
 lease_until timestamptz,
 retry_at timestamptz,
 PRIMARY KEY(conversation_id,version),
 FOREIGN KEY(conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE
);
CREATE INDEX conversation_owner_updated ON conversations(user_id,updated_at DESC);
