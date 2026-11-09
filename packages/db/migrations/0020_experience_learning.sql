CREATE TABLE learning_experiences (
 id text NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 request_id text NOT NULL, request_hash text NOT NULL, session_id text NOT NULL, run_id text NOT NULL,
 event_id text NOT NULL, payload jsonb NOT NULL CHECK(octet_length(payload::text)<=600000), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id,version), UNIQUE(user_id,request_id), FOREIGN KEY(session_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE
);
CREATE TABLE memory_atoms (
 id text NOT NULL,user_id text NOT NULL,version integer NOT NULL CHECK(version>0),experience_id text NOT NULL,experience_version integer NOT NULL DEFAULT 1,
 hash text NOT NULL,payload jsonb NOT NULL,withdrawn_at timestamptz,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id,version),FOREIGN KEY(user_id,experience_id,experience_version) REFERENCES learning_experiences(user_id,id,version) ON DELETE CASCADE
);
CREATE TABLE lesson_candidates (
 id text NOT NULL,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,version integer NOT NULL CHECK(version>0),
 request_id text NOT NULL,request_hash text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','approved','rejected','superseded','unsupported')),
 supersedes_id text,supersedes_version integer,lesson_id text,lesson_version integer,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id,version),UNIQUE(user_id,request_id),
 FOREIGN KEY(user_id,supersedes_id,supersedes_version) REFERENCES lesson_candidates(user_id,id,version)
);
CREATE TABLE lesson_candidate_evidence (
 user_id text NOT NULL,candidate_id text NOT NULL,candidate_version integer NOT NULL,atom_id text NOT NULL,atom_version integer NOT NULL,hash text NOT NULL,stance text NOT NULL CHECK(stance IN ('support','contradict')),quote text NOT NULL,
 PRIMARY KEY(user_id,candidate_id,candidate_version,atom_id,atom_version,stance),
 FOREIGN KEY(user_id,candidate_id,candidate_version) REFERENCES lesson_candidates(user_id,id,version) ON DELETE CASCADE,
 FOREIGN KEY(user_id,atom_id,atom_version) REFERENCES memory_atoms(user_id,id,version)
);
CREATE TABLE learning_jobs (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind text NOT NULL,operation_key text NOT NULL,payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','retry','completed','failed')),attempts integer NOT NULL DEFAULT 0,
 lease_token text,lease_until timestamptz,retry_at timestamptz,last_error text,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(user_id,kind,operation_key)
);
CREATE INDEX learning_jobs_pending ON learning_jobs(state,retry_at,recorded_at);
CREATE TABLE lesson_applications (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,candidate_id text,candidate_version integer,lesson_id text NOT NULL,lesson_version integer NOT NULL,run_id text NOT NULL,payload jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,run_id,lesson_id,lesson_version),FOREIGN KEY(user_id,candidate_id,candidate_version) REFERENCES lesson_candidates(user_id,id,version)
);
ALTER TABLE lesson_versions ADD COLUMN learning_condition jsonb;
ALTER TABLE lesson_versions ADD COLUMN learning_scope jsonb;
