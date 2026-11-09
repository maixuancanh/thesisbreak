ALTER TABLE lesson_candidates ADD COLUMN consolidation jsonb NOT NULL DEFAULT '{"classification":"new","relatedId":null,"relatedVersion":null,"requiresReview":true}'::jsonb;
