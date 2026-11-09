-- TDM-223 [20.1]: free starter run entitlement and the global free-run pool (E20, founder
-- decision 2026-11-08). One `free_starter_runs` row per Go of a free run (at most one reserved or
-- consumed per user and per run), one `free_run_pool` row ('global') holding what is reserved and
-- spent; the pool size is config (FREE_RUN_POOL_MICRO_USD). A free run's charges are covered by
-- credit grants of source `free_run`. packages/billing free-run.ts owns every write.
CREATE TABLE "free_run_pool" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"reserved_micro_usd" bigint DEFAULT 0 NOT NULL,
	"spent_micro_usd" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "free_run_pool_singleton" CHECK ("free_run_pool"."id" = 'global'),
	CONSTRAINT "free_run_pool_reserved_nonneg" CHECK ("free_run_pool"."reserved_micro_usd" >= 0),
	CONSTRAINT "free_run_pool_spent_nonneg" CHECK ("free_run_pool"."spent_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "free_starter_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"reserved_micro_usd" bigint NOT NULL,
	"agent_allowance_micro_usd" bigint DEFAULT 0 NOT NULL,
	"pool_spent_micro_usd" bigint DEFAULT 0 NOT NULL,
	"covered_micro_usd" bigint DEFAULT 0 NOT NULL,
	"release_reason" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "free_starter_runs_state_check" CHECK ("state" in ('reserved', 'consumed', 'released')),
	CONSTRAINT "free_starter_runs_reserved_nonneg" CHECK ("free_starter_runs"."reserved_micro_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_grants" DROP CONSTRAINT "credit_grants_source_check";--> statement-breakpoint
ALTER TABLE "free_starter_runs" ADD CONSTRAINT "free_starter_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_starter_runs" ADD CONSTRAINT "free_starter_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "free_starter_runs_one_per_user_uq" ON "free_starter_runs" USING btree ("user_id") WHERE "free_starter_runs"."state" in ('reserved', 'consumed');--> statement-breakpoint
CREATE UNIQUE INDEX "free_starter_runs_one_per_run_uq" ON "free_starter_runs" USING btree ("run_id") WHERE "free_starter_runs"."state" in ('reserved', 'consumed');--> statement-breakpoint
CREATE INDEX "free_starter_runs_user_idx" ON "free_starter_runs" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_source_check" CHECK ("source" in ('signup', 'admin', 'free_run'));
--> statement-breakpoint
INSERT INTO "free_run_pool" ("id") VALUES ('global') ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Only the privileged role (packages/billing) writes the entitlement and the pool; the tenant
-- role keeps the default SELECT, never a write.
REVOKE INSERT, UPDATE, DELETE ON "free_run_pool", "free_starter_runs" FROM anybench_app;--> statement-breakpoint
-- A `free_run` grant is tied to its free_starter_runs row, not an intervention (like `signup`).
CREATE OR REPLACE FUNCTION anybench_credit_grant_requires_intervention() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."source" IN ('signup', 'free_run') THEN
    RETURN NEW;
  END IF;
  IF NEW."intervention_id" IS NULL THEN
    RAISE EXCEPTION 'credit_grants: a % grant requires intervention_id', NEW."source"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "interventions" i
    WHERE i."id" = NEW."intervention_id" AND i."user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'credit_grants: intervention % is not about user %', NEW."intervention_id", NEW."user_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
