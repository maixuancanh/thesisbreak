CREATE TABLE "change_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pick_id" text NOT NULL,
	"base_version" integer NOT NULL,
	"changes" jsonb NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"native_id" text NOT NULL,
	CONSTRAINT "conversations_id_user_id_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "decision_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pick_id" text NOT NULL,
	"pick_version" integer NOT NULL,
	"plan_id" text,
	"plan_version" integer,
	"observation_ids" jsonb NOT NULL,
	"lesson_versions" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"citations" jsonb NOT NULL,
	"model_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"operation_key" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"evaluation_key" text NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"outcome" jsonb
);
--> statement-breakpoint
CREATE TABLE "lesson_versions" (
	"lesson_id" text NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"parent_version" integer,
	"rule" text NOT NULL,
	"scope" jsonb NOT NULL,
	"approval" text NOT NULL,
	"status" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"review_at" timestamp with time zone,
	"superseded_by" text,
	"originating_correction" text,
	CONSTRAINT "lesson_versions_lesson_id_version_pk" PRIMARY KEY("lesson_id","version"),
	CONSTRAINT "lesson_ancestry" CHECK (("lesson_versions"."version"=1 AND "lesson_versions"."parent_version" IS NULL) OR ("lesson_versions"."version">1 AND "lesson_versions"."parent_version"="lesson_versions"."version"-1)),
	CONSTRAINT "lesson_window" CHECK ("lesson_versions"."expires_at" IS NULL OR "lesson_versions"."expires_at">"lesson_versions"."effective_at")
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "lessons_id_user_id_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"native_id" text NOT NULL,
	"event_id" text,
	"question" text NOT NULL,
	"outcomes" jsonb NOT NULL,
	"rules_reference" text NOT NULL,
	"rules_hash" text NOT NULL,
	"close_time" timestamp with time zone,
	"fetched_at" timestamp with time zone NOT NULL,
	"price_as_of" timestamp with time zone NOT NULL,
	"native_unit" text NOT NULL,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"platform" text NOT NULL,
	"native_id" text NOT NULL,
	CONSTRAINT "markets_platform_native_id_pk" PRIMARY KEY("platform","native_id"),
	CONSTRAINT "platform_allowed" CHECK ("markets"."platform" IN ('polymarket','kalshi'))
);
--> statement-breakpoint
CREATE TABLE "memory_records" (
	"logical_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" integer NOT NULL,
	"type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"durable_reference" text,
	"receipt" jsonb,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"domain_event_id" text NOT NULL,
	"source_url" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"excerpt" text NOT NULL,
	"content_hash" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone NOT NULL,
	"freshness" text NOT NULL,
	"uncertainty" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"operation_key" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pick_versions" (
	"pick_id" text NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"parent_version" integer,
	"snapshot_id" text,
	"outcome" text NOT NULL,
	"reason" text,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pick_versions_pick_id_version_pk" PRIMARY KEY("pick_id","version"),
	CONSTRAINT "pick_versions_pick_id_user_id_version_unique" UNIQUE("pick_id","user_id","version"),
	CONSTRAINT "pick_ancestry" CHECK (("pick_versions"."version"=1 AND "pick_versions"."parent_version" IS NULL) OR ("pick_versions"."version">1 AND "pick_versions"."parent_version"="pick_versions"."version"-1))
);
--> statement-breakpoint
CREATE TABLE "picks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"native_id" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'following' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "picks_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "pick_version_positive" CHECK ("picks"."current_version">0)
);
--> statement-breakpoint
CREATE TABLE "mutation_requests" (
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mutation_requests_user_id_request_id_pk" PRIMARY KEY("user_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"native_id" text NOT NULL,
	"rules_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"official_reference" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"status" text NOT NULL,
	"text" text NOT NULL,
	"references" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turns_user_id_client_request_id_unique" UNIQUE("user_id","client_request_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_provider_subject_unique" UNIQUE("provider_subject")
);
--> statement-breakpoint
CREATE TABLE "watch_plan_versions" (
	"plan_id" text NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"parent_version" integer,
	"pick_id" text NOT NULL,
	"pick_version" integer NOT NULL,
	"condition" jsonb NOT NULL,
	"source_ids" jsonb NOT NULL,
	"procedure_version" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"channel" text NOT NULL,
	"approved_at" timestamp with time zone,
	"state" text NOT NULL,
	CONSTRAINT "watch_plan_versions_plan_id_version_pk" PRIMARY KEY("plan_id","version"),
	CONSTRAINT "plan_ancestry" CHECK (("watch_plan_versions"."version"=1 AND "watch_plan_versions"."parent_version" IS NULL) OR ("watch_plan_versions"."version">1 AND "watch_plan_versions"."parent_version"="watch_plan_versions"."version"-1)),
	CONSTRAINT "active_plan_approved" CHECK ("watch_plan_versions"."state"<>'active' OR ("watch_plan_versions"."approved_at" IS NOT NULL AND "watch_plan_versions"."deadline">"watch_plan_versions"."approved_at"))
);
--> statement-breakpoint
CREATE TABLE "watch_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pick_id" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "watch_plans_id_user_id_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "change_proposals_pick_id_user_id_base_version_pick_versions_pick_id_user_id_version_fk" FOREIGN KEY ("pick_id","user_id","base_version") REFERENCES "public"."pick_versions"("pick_id","user_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_platform_native_id_markets_platform_native_id_fk" FOREIGN KEY ("platform","native_id") REFERENCES "public"."markets"("platform","native_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_traces" ADD CONSTRAINT "decision_traces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_traces" ADD CONSTRAINT "decision_traces_pick_id_user_id_pick_version_pick_versions_pick_id_user_id_version_fk" FOREIGN KEY ("pick_id","user_id","pick_version") REFERENCES "public"."pick_versions"("pick_id","user_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_evaluation_key_outbox_operation_key_fk" FOREIGN KEY ("evaluation_key") REFERENCES "public"."outbox"("operation_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_versions" ADD CONSTRAINT "lesson_versions_lesson_id_user_id_lessons_id_user_id_fk" FOREIGN KEY ("lesson_id","user_id") REFERENCES "public"."lessons"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_versions" ADD CONSTRAINT "lesson_versions_lesson_id_parent_version_lesson_versions_lesson_id_version_fk" FOREIGN KEY ("lesson_id","parent_version") REFERENCES "public"."lesson_versions"("lesson_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_platform_native_id_markets_platform_native_id_fk" FOREIGN KEY ("platform","native_id") REFERENCES "public"."markets"("platform","native_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_versions" ADD CONSTRAINT "pick_versions_snapshot_id_market_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."market_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_versions" ADD CONSTRAINT "pick_version_owner_fk" FOREIGN KEY ("pick_id","user_id") REFERENCES "public"."picks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_versions" ADD CONSTRAINT "pick_parent_fk" FOREIGN KEY ("pick_id","parent_version") REFERENCES "public"."pick_versions"("pick_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picks" ADD CONSTRAINT "picks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picks" ADD CONSTRAINT "picks_platform_native_id_markets_platform_native_id_fk" FOREIGN KEY ("platform","native_id") REFERENCES "public"."markets"("platform","native_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_requests" ADD CONSTRAINT "mutation_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_platform_native_id_markets_platform_native_id_fk" FOREIGN KEY ("platform","native_id") REFERENCES "public"."markets"("platform","native_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_user_id_conversations_id_user_id_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."conversations"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_plan_versions" ADD CONSTRAINT "watch_plan_versions_plan_id_user_id_watch_plans_id_user_id_fk" FOREIGN KEY ("plan_id","user_id") REFERENCES "public"."watch_plans"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_plan_versions" ADD CONSTRAINT "watch_plan_versions_pick_id_user_id_pick_version_pick_versions_pick_id_user_id_version_fk" FOREIGN KEY ("pick_id","user_id","pick_version") REFERENCES "public"."pick_versions"("pick_id","user_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_plan_versions" ADD CONSTRAINT "watch_plan_versions_plan_id_parent_version_watch_plan_versions_plan_id_version_fk" FOREIGN KEY ("plan_id","parent_version") REFERENCES "public"."watch_plan_versions"("plan_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_plans" ADD CONSTRAINT "watch_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_plans" ADD CONSTRAINT "watch_plans_pick_id_user_id_picks_id_user_id_fk" FOREIGN KEY ("pick_id","user_id") REFERENCES "public"."picks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_records_user_id_sync_status_index" ON "memory_records" USING btree ("user_id","sync_status");