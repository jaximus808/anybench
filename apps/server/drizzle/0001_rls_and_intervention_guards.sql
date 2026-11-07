-- TDM-11: tenancy (RLS) and the intervention guards. Hand-written (drizzle-kit generate --custom).
--
-- RLS. Table owners bypass RLS, and the app pool connects as the owner (neondb_owner on Neon,
-- anybench locally). So tenant queries run as the NON-owner role anybench_app: scopedDb(actor)
-- does `SET LOCAL ROLE anybench_app` and `set_config('app.actor_id', <user id>, true)` inside its
-- transaction. The policies below then filter by owner_id even if the query forgets its WHERE.
-- System code (worker, webhooks) uses the owner connection directly and sees everything.

-- 1. The app role. Roles are cluster-wide, so tolerate it already existing (another database on
--    the same cluster, or a concurrent test run).
DO $$
BEGIN
  CREATE ROLE anybench_app NOLOGIN NOBYPASSRLS;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
--> statement-breakpoint
-- The migrating user (the pool user) must be able to SET ROLE anybench_app.
DO $$
BEGIN
  EXECUTE format('GRANT anybench_app TO %I', current_user);
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO anybench_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anybench_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anybench_app;
--> statement-breakpoint
-- Tables and sequences created by later migrations (run by the same owner) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anybench_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anybench_app;
--> statement-breakpoint

-- 2. The current actor. NULL when unset or reset to '' after an earlier SET LOCAL, so a
--    transaction without an actor sees no tenant rows at all.
CREATE OR REPLACE FUNCTION anybench_actor_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.actor_id', true), '')::uuid $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anybench_actor_id() TO anybench_app;
--> statement-breakpoint

-- 3. RLS on the tenant tables (plan.md section 9). ENABLE (not FORCE): the owner keeps full access
--    for system code; anybench_app is never the owner, so the policies always apply to it.
--    WITH CHECK also requires the parent row to be visible to the actor (the subquery is itself
--    filtered by RLS), so a tenant cannot attach rows to someone else's run or trial.
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "runs_tenant" ON "runs" FOR ALL TO anybench_app
  USING ("owner_id" = anybench_actor_id())
  WITH CHECK ("owner_id" = anybench_actor_id());
--> statement-breakpoint
ALTER TABLE "kits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "kits_tenant" ON "kits" FOR ALL TO anybench_app
  USING ("owner_id" = anybench_actor_id())
  WITH CHECK (
    "owner_id" = anybench_actor_id()
    AND EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "kits"."run_id")
  );
--> statement-breakpoint
ALTER TABLE "trials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trials_tenant" ON "trials" FOR ALL TO anybench_app
  USING ("owner_id" = anybench_actor_id())
  WITH CHECK (
    "owner_id" = anybench_actor_id()
    AND EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "trials"."run_id")
  );
--> statement-breakpoint
ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "reviews_tenant" ON "reviews" FOR ALL TO anybench_app
  USING ("owner_id" = anybench_actor_id())
  WITH CHECK (
    "owner_id" = anybench_actor_id()
    AND EXISTS (SELECT 1 FROM "trials" t WHERE t."id" = "reviews"."trial_id")
  );
--> statement-breakpoint
ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "reports_tenant" ON "reports" FOR ALL TO anybench_app
  USING ("owner_id" = anybench_actor_id())
  WITH CHECK (
    "owner_id" = anybench_actor_id()
    AND EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "reports"."run_id")
  );
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "events_tenant" ON "events" FOR ALL TO anybench_app
  USING ("owner_id" = anybench_actor_id())
  WITH CHECK (
    "owner_id" = anybench_actor_id()
    AND ("run_id" IS NULL OR EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "events"."run_id"))
  );
--> statement-breakpoint
ALTER TABLE "user_secrets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_secrets_tenant" ON "user_secrets" FOR ALL TO anybench_app
  USING ("owner_id" = anybench_actor_id())
  WITH CHECK ("owner_id" = anybench_actor_id());
--> statement-breakpoint

-- 4. Intervention guards (plan.md section 8, demo bypass). Every admin grant and every comp must
--    carry an interventions row about the same user / run, written in the same transaction.
CREATE OR REPLACE FUNCTION anybench_credit_grant_requires_intervention() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."source" = 'signup' THEN
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
--> statement-breakpoint
CREATE TRIGGER "credit_grants_require_intervention"
  BEFORE INSERT OR UPDATE ON "credit_grants"
  FOR EACH ROW EXECUTE FUNCTION anybench_credit_grant_requires_intervention();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION anybench_run_comp_requires_intervention() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."comped_by" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."comp_intervention_id" IS NULL THEN
    RAISE EXCEPTION 'runs: comping run % requires comp_intervention_id', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "interventions" i
    WHERE i."id" = NEW."comp_intervention_id" AND i."run_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'runs: intervention % is not about run %', NEW."comp_intervention_id", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "runs_comp_requires_intervention"
  BEFORE INSERT OR UPDATE OF "comped_by", "comp_intervention_id" ON "runs"
  FOR EACH ROW EXECUTE FUNCTION anybench_run_comp_requires_intervention();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION anybench_usage_comp_requires_intervention() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."comped_by" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."intervention_id" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "interventions" i
    WHERE i."id" = NEW."intervention_id" AND i."run_id" IS NOT DISTINCT FROM NEW."run_id"
  ) THEN
    RAISE EXCEPTION 'usage_entries: comped usage % requires an intervention for its run', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "usage_entries_comp_requires_intervention"
  BEFORE INSERT OR UPDATE ON "usage_entries"
  FOR EACH ROW EXECUTE FUNCTION anybench_usage_comp_requires_intervention();
