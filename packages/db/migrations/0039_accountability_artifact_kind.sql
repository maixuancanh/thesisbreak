-- New artifact type requires a separate exact-snapshot inspection and grant.
ALTER TABLE research_artifact_memory_grants DROP CONSTRAINT research_artifact_memory_grants_kind_check;
ALTER TABLE research_artifact_memory_grants ADD CONSTRAINT research_artifact_memory_grants_kind_check CHECK(kind IN ('source_change','forecast_rationale','forecast_result','drift_summary','decision_recap','accountability_review'));
