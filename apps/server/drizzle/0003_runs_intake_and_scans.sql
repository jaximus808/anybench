CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"github_owner" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_repos" jsonb,
	"max_repos" integer DEFAULT 20 NOT NULL,
	"repos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scans_status_check" CHECK ("status" in ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "scans_cost_nonneg" CHECK ("scans"."cost_micro_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "intake" jsonb;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scans_owner_id_idx" ON "scans" USING btree ("owner_id");--> statement-breakpoint
-- TDM-67: scans are tenant data, same policy shape as runs (0001). Grants come from the default
-- privileges set in 0001.
ALTER TABLE "scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scans_tenant" ON "scans" FOR ALL TO anybench_app
  USING ("owner_id" = anybench_actor_id())
  WITH CHECK ("owner_id" = anybench_actor_id());
