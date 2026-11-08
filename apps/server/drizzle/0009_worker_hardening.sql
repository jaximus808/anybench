CREATE TABLE "provider_breakers" (
	"provider" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'closed' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"next_probe_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_breakers_status_check" CHECK ("provider_breakers"."status" in ('closed', 'open'))
);
--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "outage_pauses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "graphile_worker_ids" text[];