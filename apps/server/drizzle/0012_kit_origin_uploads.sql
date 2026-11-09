-- TDM-217 [19.1]: bring your own kit. A kit records where it came from (`origin`), an uploaded
-- kit has no run until a run is created from it (`run_id` nullable for `uploaded` only), and
-- `upload_id` makes completing the same upload twice return the same row.
ALTER TABLE "kits" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kits" ADD COLUMN "origin" text DEFAULT 'generated' NOT NULL;--> statement-breakpoint
ALTER TABLE "kits" ADD COLUMN "upload_id" uuid;--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_upload_id_uq" UNIQUE("upload_id");--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_origin_check" CHECK ("origin" in ('generated', 'curated', 'uploaded'));--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_run_unless_uploaded_check" CHECK ("run_id" IS NOT NULL OR "origin" = 'uploaded');--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_upload_id_uploaded_check" CHECK ("upload_id" IS NULL OR "origin" = 'uploaded');
--> statement-breakpoint
-- RLS: the kits policy required a visible parent run on write; an uploaded kit has none. Owner
-- only still holds, and a kit that names a run must still name one the actor can see.
DROP POLICY IF EXISTS "kits_tenant" ON "kits";--> statement-breakpoint
CREATE POLICY "kits_tenant" ON "kits" FOR ALL TO anybench_app
  USING ("owner_id" = anybench_actor_id())
  WITH CHECK (
    "owner_id" = anybench_actor_id()
    AND ("run_id" IS NULL OR EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "kits"."run_id"))
  );
