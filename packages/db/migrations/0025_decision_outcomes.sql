CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_owner_identity ON agent_runs(id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS proposal_owner_pick_identity ON change_proposals(id,user_id,pick_id);
CREATE TABLE decision_outcomes (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 id text NOT NULL,proposal_id text NOT NULL,pick_id text NOT NULL,root_run_id text,
 decision text NOT NULL CHECK(decision IN ('confirmed','rejected')),
 request_id text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,proposal_id),UNIQUE(user_id,request_id),
 FOREIGN KEY(proposal_id,user_id,pick_id) REFERENCES change_proposals(id,user_id,pick_id) ON DELETE CASCADE,
 FOREIGN KEY(root_run_id,user_id) REFERENCES agent_runs(id,user_id) ON DELETE CASCADE
);
