CREATE TABLE "market_monitors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pick_id" text NOT NULL,
	"pick_version" integer NOT NULL,
	"platform" text NOT NULL,
	"native_id" text NOT NULL,
	"provider" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"observation" jsonb,
	"source_health" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_monitors_user_id_pick_id_unique" UNIQUE("user_id","pick_id"),
	CONSTRAINT "monitor_state" CHECK ("market_monitors"."state" IN ('active','paused','expired','superseded'))
);
--> statement-breakpoint
CREATE TABLE "market_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"monitor_id" text NOT NULL,
	"user_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_updates_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "market_monitors" ADD CONSTRAINT "market_monitors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_monitors" ADD CONSTRAINT "market_monitors_pick_id_user_id_pick_version_pick_versions_pick_id_user_id_version_fk" FOREIGN KEY ("pick_id","user_id","pick_version") REFERENCES "public"."pick_versions"("pick_id","user_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_updates" ADD CONSTRAINT "market_updates_monitor_id_market_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."market_monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_updates" ADD CONSTRAINT "market_updates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_monitors_state_next_check_at_index" ON "market_monitors" USING btree ("state","next_check_at");