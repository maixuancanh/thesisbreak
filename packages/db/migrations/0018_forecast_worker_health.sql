CREATE TABLE forecast_worker_health (
 job text PRIMARY KEY,
 lease_owner text,
 lease_until timestamptz,
 last_started_at timestamptz,
 last_success_at timestamptz,
 last_failed_at timestamptz,
 summary jsonb
);
