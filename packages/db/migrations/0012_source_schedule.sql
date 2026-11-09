ALTER TABLE source_forecasts ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE INDEX source_forecast_check_idx ON source_forecasts(next_check_at);
