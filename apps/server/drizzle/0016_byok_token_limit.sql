-- TDM-245 [21.5]: a run-level hard stop on model tokens on the user's own key (BYOK). Null: no
-- limit (BYOK tokens are reported, as before). Set: orchestrator/budget.ts admits a launch only when
-- byok_token_micro_usd + the BYOK caps of the trials in flight + the next trial's BYOK cap fit.
ALTER TABLE "runs" ADD COLUMN "byok_token_limit_micro_usd" bigint;
