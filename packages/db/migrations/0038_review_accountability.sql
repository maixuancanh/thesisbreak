-- Additive accountability state. No legacy claims, consent, forecasts or receipts are backfilled.
ALTER TABLE agent_runs ADD CONSTRAINT accountability_run_owner_session UNIQUE(id,user_id,conversation_id);
ALTER TABLE decision_recap_versions ADD CONSTRAINT accountability_recap_owner UNIQUE(id,user_id);
CREATE TABLE review_cases (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_id text NOT NULL,trigger_evidence_revision_id text NOT NULL,reason_dependency_id text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),payload jsonb NOT NULL CHECK(octet_length(payload::text)<=131072),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,event_id,trigger_evidence_revision_id,reason_dependency_id),UNIQUE(id,user_id),UNIQUE(id,user_id,revision),
 FOREIGN KEY(trigger_evidence_revision_id,user_id) REFERENCES source_change_events(id,user_id) ON DELETE CASCADE
);
CREATE TABLE review_case_picks (
 case_id text NOT NULL,user_id text NOT NULL,pick_id text NOT NULL,pick_version integer NOT NULL CHECK(pick_version>0),
 reason_id text NOT NULL,reason_version integer NOT NULL CHECK(reason_version>0),assessment_id text,
 disposition text NOT NULL DEFAULT 'pending' CHECK(disposition IN ('pending','kept','updated','stopped')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(case_id,pick_id,reason_id),UNIQUE(case_id,user_id,pick_id,reason_id,pick_version,reason_version),
 FOREIGN KEY(case_id,user_id) REFERENCES review_cases(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(pick_id,user_id,pick_version) REFERENCES pick_versions(pick_id,user_id,version) ON DELETE CASCADE,
 FOREIGN KEY(reason_id,user_id,pick_id,pick_version,reason_version) REFERENCES pick_reason_versions(id,user_id,pick_id,pick_version,revision) ON DELETE CASCADE,
 FOREIGN KEY(assessment_id,user_id) REFERENCES pick_impact_assessments(id,user_id) ON DELETE CASCADE
);
CREATE TABLE answer_claims (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id text NOT NULL,message_id text NOT NULL,
 answer_revision integer NOT NULL CHECK(answer_revision>0),claim_id text NOT NULL,
 claim_text_hash text NOT NULL CHECK(claim_text_hash ~ '^[a-f0-9]{64}$'),claim_text text NOT NULL CHECK(length(claim_text) BETWEEN 1 AND 4000),
 evidence_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(evidence_ids)='array' AND jsonb_array_length(evidence_ids)<=100),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(user_id,message_id,answer_revision,claim_id),
 UNIQUE(user_id,session_id,message_id,answer_revision,claim_id),
 FOREIGN KEY(message_id,user_id,session_id) REFERENCES agent_runs(id,user_id,conversation_id) ON DELETE CASCADE
);
CREATE TABLE claim_challenges (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id text NOT NULL,
 message_id text NOT NULL,answer_revision integer NOT NULL CHECK(answer_revision>0),claim_id text NOT NULL,
 client_request_id text NOT NULL,request_hash text NOT NULL,explanation text NOT NULL CHECK(length(explanation) BETWEEN 1 AND 4000),
 evidence_urls jsonb NOT NULL CHECK(jsonb_typeof(evidence_urls)='array' AND jsonb_array_length(evidence_urls)<=5),
 status text NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','checking','needs_evidence','accepted','not_supported','withdrawn')),
 current_revision integer NOT NULL DEFAULT 1 CHECK(current_revision>0),payload jsonb NOT NULL CHECK(octet_length(payload::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,user_id),UNIQUE(user_id,client_request_id),
 FOREIGN KEY(user_id,session_id,message_id,answer_revision,claim_id) REFERENCES answer_claims(user_id,session_id,message_id,answer_revision,claim_id) ON DELETE CASCADE
);
CREATE TABLE claim_challenge_revisions (
 id text PRIMARY KEY,user_id text NOT NULL,challenge_id text NOT NULL,revision integer NOT NULL CHECK(revision>0),
 status text NOT NULL CHECK(status IN ('submitted','checking','needs_evidence','accepted','not_supported','withdrawn')),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=65536),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(challenge_id,user_id,revision),FOREIGN KEY(challenge_id,user_id) REFERENCES claim_challenges(id,user_id) ON DELETE CASCADE
);
CREATE TABLE explanation_reviews (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,pick_id text NOT NULL,recap_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),status text NOT NULL CHECK(status IN ('not_assessed','supported','under_review','corrected','inconclusive')),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=131072),supersedes_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(user_id,pick_id,revision),UNIQUE(id,user_id,pick_id),
 FOREIGN KEY(pick_id,user_id) REFERENCES picks(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(recap_id,user_id,pick_id) REFERENCES decision_recap_versions(id,user_id,pick_id) ON DELETE CASCADE,
 FOREIGN KEY(supersedes_id,user_id,pick_id) REFERENCES explanation_reviews(id,user_id,pick_id)
);
CREATE TABLE decision_evidence_assessments (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,case_id text NOT NULL,case_revision integer NOT NULL CHECK(case_revision>0),
 pick_id text NOT NULL,pick_version integer NOT NULL CHECK(pick_version>0),reason_id text NOT NULL,reason_version integer NOT NULL CHECK(reason_version>0),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=65536),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,case_id,case_revision,pick_id,reason_id,reason_version),
 FOREIGN KEY(case_id,user_id) REFERENCES review_cases(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(reason_id,user_id,pick_id,pick_version,reason_version) REFERENCES pick_reason_versions(id,user_id,pick_id,pick_version,revision) ON DELETE CASCADE
);
CREATE TABLE review_followups (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,case_id text NOT NULL,case_revision integer NOT NULL CHECK(case_revision>0),
 pick_id text NOT NULL,pick_version integer NOT NULL CHECK(pick_version>0),reason_id text NOT NULL,reason_version integer NOT NULL CHECK(reason_version>0),
 channel text NOT NULL DEFAULT 'in_app' CHECK(channel='in_app'),state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','snoozed','acknowledged','superseded','stopped')),
 due_at timestamptz,timezone text NOT NULL DEFAULT 'UTC',delivered_at timestamptz,payload jsonb NOT NULL CHECK(octet_length(payload::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(state<>'snoozed' OR due_at IS NOT NULL),UNIQUE(user_id,case_id,case_revision,pick_id,reason_id,reason_version,channel),
 FOREIGN KEY(case_id,user_id) REFERENCES review_cases(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(case_id,user_id,pick_id,reason_id,pick_version,reason_version) REFERENCES review_case_picks(case_id,user_id,pick_id,reason_id,pick_version,reason_version) ON DELETE CASCADE
);
CREATE INDEX accountability_cases_owner ON review_cases(user_id,updated_at DESC,id);
CREATE INDEX accountability_followups_due ON review_followups(due_at,id) WHERE state IN ('pending','snoozed');
CREATE INDEX accountability_challenges_owner ON claim_challenges(user_id,status,created_at,id);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['review_cases','review_case_picks','answer_claims','claim_challenges','claim_challenge_revisions','explanation_reviews','decision_evidence_assessments','review_followups'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY owner_isolation ON %I USING (user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',t);
 END LOOP; END $$;
CREATE TRIGGER answer_claims_append_only BEFORE UPDATE ON answer_claims FOR EACH ROW EXECUTE FUNCTION protect_pick_monitoring_history();
CREATE TRIGGER challenge_revision_append_only BEFORE UPDATE ON claim_challenge_revisions FOR EACH ROW EXECUTE FUNCTION protect_pick_monitoring_history();
CREATE TRIGGER explanation_review_append_only BEFORE UPDATE ON explanation_reviews FOR EACH ROW EXECUTE FUNCTION protect_pick_monitoring_history();
CREATE TRIGGER decision_evidence_append_only BEFORE UPDATE ON decision_evidence_assessments FOR EACH ROW EXECUTE FUNCTION protect_pick_monitoring_history();
