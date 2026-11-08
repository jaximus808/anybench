ALTER TABLE "runs" ADD COLUMN "cancel_cause" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "stage_outputs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "advance_lease_owner" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "advance_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cancel_cause_check" CHECK ("cancel_cause" is null or "cancel_cause" in ('user', 'ours'));