-- TDM-246 [21.6]: each attempt's metered model-token spend, so a retried attempt never overwrites
-- (lowers) a trial's recorded spend. token_spend_micro_usd becomes the sum over attempts; scoring
-- reads the scored attempt's own entry.
ALTER TABLE "trials" ADD COLUMN "token_spend_by_attempt" jsonb;--> statement-breakpoint
-- A spend recorded before this column was the latest attempt's (each attempt overwrote it).
UPDATE "trials" SET "token_spend_by_attempt" = jsonb_build_object("attempt"::text, "token_spend_micro_usd"::text) WHERE "token_spend_micro_usd" IS NOT NULL;
