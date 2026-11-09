CREATE TABLE "independent_watch_baselines" (
	"monitor_id" text NOT NULL,
	"source" text NOT NULL,
	"pick_version" integer NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "independent_watch_baselines_monitor_id_source_pk" PRIMARY KEY("monitor_id","source")
);
--> statement-breakpoint
ALTER TABLE "independent_watch_baselines" ADD CONSTRAINT "independent_watch_baselines_monitor_id_market_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."market_monitors"("id") ON DELETE cascade ON UPDATE no action;