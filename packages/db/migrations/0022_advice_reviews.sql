ALTER TABLE decision_receipts DROP CONSTRAINT IF EXISTS decision_receipts_publication_state_check;
ALTER TABLE decision_receipts ADD CONSTRAINT decision_receipts_publication_state_check CHECK(publication_state IN ('not_requested','pending','published','verified','failed'));
CREATE TABLE decision_advice_reviews (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,operation_key text NOT NULL,decision_id text NOT NULL,event_id text NOT NULL,
 dependency_id text NOT NULL,dependency_status text NOT NULL,explanation text NOT NULL,
 state text NOT NULL CHECK(state IN ('review_required','monitoring_disabled')),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,operation_key)
);
