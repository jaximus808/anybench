-- TDM-242 [20.5]: enforce every run's budget. runs.spent_micro_usd is kept current by the
-- orchestrator (orchestrator/budget.ts); committed_micro_usd is the worst case of trials in
-- flight; byok_token_micro_usd is model tokens on the user's own key (reported, not billed);
-- budget_basis / budget_limit_micro_usd say which limit holds the run (a free run: the free-run
-- cap at our cost). trials.token_spend_micro_usd is the runner-metered token spend of the attempt.
ALTER TABLE "runs" ADD COLUMN "committed_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "byok_token_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "budget_basis" text DEFAULT 'billed' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "budget_limit_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "token_spend_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_budget_basis_check" CHECK ("budget_basis" in ('billed', 'free_run'));