ALTER TABLE "watch_plans" ADD CONSTRAINT "watch_plans_id_user_id_pick_id_unique" UNIQUE("id","user_id","pick_id");
--> statement-breakpoint
ALTER TABLE "watch_plan_versions" DROP CONSTRAINT "watch_plan_versions_plan_id_user_id_watch_plans_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "watch_plan_versions" ADD CONSTRAINT "watch_plan_versions_plan_id_user_id_pick_id_watch_plans_id_user_id_pick_id_fk" FOREIGN KEY ("plan_id","user_id","pick_id") REFERENCES "public"."watch_plans"("id","user_id","pick_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
