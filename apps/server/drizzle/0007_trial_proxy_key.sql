ALTER TABLE "trials" ADD COLUMN "proxy_key_id" text;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "proxy_key_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "proxy_key_attempt" integer;