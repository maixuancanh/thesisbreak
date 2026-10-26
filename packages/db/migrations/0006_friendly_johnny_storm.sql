CREATE TABLE "independent_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"native_id" text NOT NULL,
	"source" text NOT NULL,
	"item" jsonb NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "independent_source_checks" (
	"platform" text NOT NULL,
	"native_id" text NOT NULL,
	"source" text NOT NULL,
	"value" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "independent_source_checks_platform_native_id_source_pk" PRIMARY KEY("platform","native_id","source")
);
--> statement-breakpoint
CREATE INDEX "independent_evidence_platform_native_id_index" ON "independent_evidence" USING btree ("platform","native_id");