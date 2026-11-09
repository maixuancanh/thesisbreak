ALTER TABLE nba_forecast_memory_receipts ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE nba_forecast_memory_receipts DROP CONSTRAINT nba_forecast_memory_receipts_pkey;
ALTER TABLE nba_forecast_memory_receipts ADD PRIMARY KEY(forecast_id,version);
