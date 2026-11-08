-- Publications (E12 minimal): the frozen, signed snapshot's canonical text, withdrawal time, one
-- publication per run, and immutable versions.
ALTER TABLE "publish_versions" ADD COLUMN "signed_text" text NOT NULL;--> statement-breakpoint
ALTER TABLE "published_benchmarks" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "published_benchmarks_run_id_uq" ON "published_benchmarks" USING btree ("run_id") WHERE "published_benchmarks"."run_id" is not null;--> statement-breakpoint
-- A published version never changes: publishing again writes the next version instead.
CREATE OR REPLACE FUNCTION publish_versions_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'publish_versions rows are immutable (publish a new version instead)'
    USING ERRCODE = 'check_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER publish_versions_no_update BEFORE UPDATE ON "publish_versions"
  FOR EACH ROW EXECUTE FUNCTION publish_versions_immutable();
