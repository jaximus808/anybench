CREATE TABLE "agent_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"naive_seq" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_events_session_seq_uq" UNIQUE("agent_session_id","naive_seq")
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"role" text NOT NULL,
	"naive_session_id" text,
	"budget_micro_usd" bigint NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"pending_action" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_naive_session_id_unique" UNIQUE("naive_session_id")
);
--> statement-breakpoint
CREATE TABLE "alert_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"min_severity" text DEFAULT 'warn' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_channels_kind_check" CHECK ("kind" in ('in_app', 'email', 'slack', 'tandem')),
	CONSTRAINT "alert_channels_min_severity_check" CHECK ("min_severity" in ('info', 'warn', 'critical', 'page'))
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_deliveries_alert_channel_uq" UNIQUE("alert_id","channel_id"),
	CONSTRAINT "alert_deliveries_status_check" CHECK ("status" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"condition" jsonb NOT NULL,
	"severity" text NOT NULL,
	"cooldown_s" integer DEFAULT 0 NOT NULL,
	"auto_action" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_rules_scope_check" CHECK ("scope" in ('global', 'user', 'run', 'trial', 'computer')),
	CONSTRAINT "alert_rules_severity_check" CHECK ("severity" in ('info', 'warn', 'critical', 'page'))
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"run_id" uuid,
	"user_id" uuid,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"acked_by" text,
	"acked_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "alerts_severity_check" CHECK ("severity" in ('info', 'warn', 'critical', 'page')),
	CONSTRAINT "alerts_status_check" CHECK ("status" in ('open', 'acked', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"run_ids" uuid[],
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "billing_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text,
	"subscription_id" text,
	"payment_status" text DEFAULT 'none' NOT NULL,
	"has_payment_method" boolean DEFAULT false NOT NULL,
	"unbilled_micro_usd" bigint DEFAULT 0 NOT NULL,
	"granted_remaining_micro_usd" bigint DEFAULT 0 NOT NULL,
	"spend_limit_micro_usd" bigint,
	"first_paid_invoice_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "billing_accounts_payment_status_check" CHECK ("payment_status" in ('none', 'ok', 'past_due', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "bottlenecks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"cause" text NOT NULL,
	"evidence" jsonb,
	"suggested_fix" text,
	"trial_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text,
	"run_id" uuid,
	"trial_id" uuid,
	"snapshot_id" text,
	"status" text DEFAULT 'creating' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destroyed_at" timestamp with time zone,
	"blocks_billed" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "computers_provider_id_uq" UNIQUE("provider","provider_id"),
	CONSTRAINT "computers_status_check" CHECK ("status" in ('creating', 'running', 'destroying', 'destroyed', 'leaked', 'error'))
);
--> statement-breakpoint
CREATE TABLE "contenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kit_id" uuid,
	"source" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"reason" text,
	"found_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contenders_status_check" CHECK ("status" in ('candidate', 'kept', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"run_id" uuid,
	"amount_micro_usd" bigint NOT NULL,
	"ref" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_entries_source_check" CHECK ("source" in ('naive', 'vm', 'storage', 'vercel'))
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_credit_grant_id" text,
	"amount_micro_usd" bigint NOT NULL,
	"category" text NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"intervention_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grants_stripe_credit_grant_id_unique" UNIQUE("stripe_credit_grant_id"),
	CONSTRAINT "credit_grants_amount_positive" CHECK ("credit_grants"."amount_micro_usd" > 0),
	CONSTRAINT "credit_grants_category_check" CHECK ("category" in ('promotional', 'paid')),
	CONSTRAINT "credit_grants_source_check" CHECK ("source" in ('signup', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "embed_views" (
	"benchmark_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"referrer_host" text DEFAULT '' NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "embed_views_pk" PRIMARY KEY("benchmark_id","kind","referrer_host","day"),
	CONSTRAINT "embed_views_kind_check" CHECK ("kind" in ('badge', 'embed', 'page'))
);
--> statement-breakpoint
CREATE TABLE "envs" (
	"spec_hash" text NOT NULL,
	"profile" text NOT NULL,
	"provider" text NOT NULL,
	"snapshot_id" text,
	"built_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"health" jsonb,
	CONSTRAINT "envs_pk" PRIMARY KEY("spec_hash","provider")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" uuid,
	"run_id" uuid,
	"seq" bigint NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"type" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"actor" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_delta_micro_usd" bigint DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_run_seq_uq" UNIQUE("run_id","seq"),
	CONSTRAINT "events_source_check" CHECK ("source" in ('run', 'trial', 'agent_session', 'computer', 'ledger', 'alert', 'billing', 'publish', 'system')),
	CONSTRAINT "events_severity_check" CHECK ("severity" in ('debug', 'info', 'warn', 'error', 'critical', 'page'))
);
--> statement-breakpoint
CREATE TABLE "interventions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"user_id" uuid,
	"who" text NOT NULL,
	"what" text NOT NULL,
	"why" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"run_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"clicked_at" timestamp with time zone,
	"claimed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text,
	"reason" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	CONSTRAINT "kill_switches_scope_check" CHECK ("scope" in ('global', 'run', 'user')),
	CONSTRAINT "kill_switches_scope_id_check" CHECK (("kill_switches"."scope" = 'global') = ("kill_switches"."scope_id" is null))
);
--> statement-breakpoint
CREATE TABLE "kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"files_url" text,
	"proof" jsonb,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kits_run_version_uq" UNIQUE("run_id","version")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"query" text,
	"company" text,
	"contact" text,
	"email" text,
	"github_url" text,
	"signals" jsonb,
	"fit" double precision,
	"status" text DEFAULT 'new' NOT NULL,
	"digest_id" uuid,
	"kit_id" uuid,
	"brief" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"html" text,
	"text" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"agentmail_message_id" text,
	"approved_by" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_messages_agentmail_message_id_unique" UNIQUE("agentmail_message_id"),
	CONSTRAINT "outreach_messages_kind_check" CHECK ("kind" in ('initial', 'followup', 'reply')),
	CONSTRAINT "outreach_messages_status_check" CHECK ("status" in ('draft', 'approved', 'sent', 'bounced', 'replied'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"digest" jsonb,
	"kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"benchmark_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"report_json" jsonb NOT NULL,
	"attestation" jsonb NOT NULL,
	"signature" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_versions_benchmark_version_uq" UNIQUE("benchmark_id","version")
);
--> statement-breakpoint
CREATE TABLE "published_benchmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"run_id" uuid,
	"visibility" text DEFAULT 'unlisted' NOT NULL,
	"pinned_version" integer,
	"auto_publish" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "published_benchmarks_slug_unique" UNIQUE("slug"),
	CONSTRAINT "published_benchmarks_visibility_check" CHECK ("visibility" in ('public', 'unlisted', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"json" jsonb NOT NULL,
	"md" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"trial_id" uuid NOT NULL,
	"criterion" text NOT NULL,
	"score" double precision NOT NULL,
	"evidence" jsonb,
	"review_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"question" text NOT NULL,
	"state" text DEFAULT 'intake' NOT NULL,
	"budget_micro_usd" bigint NOT NULL,
	"spent_micro_usd" bigint DEFAULT 0 NOT NULL,
	"estimate_micro_usd" bigint,
	"kit_id" uuid,
	"next_seq" bigint DEFAULT 1 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"paused_reason" text,
	"comped_by" text,
	"comped_reason" text,
	"comp_intervention_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_state_check" CHECK ("state" in ('intake', 'understand', 'research', 'kit_draft', 'env_build', 'proof', 'awaiting_go', 'running', 'scoring', 'analyzing', 'delivered', 'failed', 'needs_human', 'paused_budget', 'cancelled')),
	CONSTRAINT "runs_budget_nonneg" CHECK ("runs"."budget_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"contender_id" uuid NOT NULL,
	"workload_id" text NOT NULL,
	"repeat" integer NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"computer_id" uuid,
	"provider" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"machine" jsonb,
	"metrics" jsonb,
	"gate" jsonb,
	"failure_class" text,
	"exit_code" integer,
	"log_offset" bigint DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"logs_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trials_slot_uq" UNIQUE("run_id","contender_id","workload_id","repeat"),
	CONSTRAINT "trials_state_check" CHECK ("state" in ('queued', 'forking', 'installing', 'warming', 'running', 'collecting', 'gating', 'reviewing', 'done', 'failed_infra', 'failed_subject', 'cancelled')),
	CONSTRAINT "trials_attempt_check" CHECK ("trials"."attempt" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "usage_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid,
	"trial_id" uuid,
	"type" text NOT NULL,
	"amount_micro_usd" bigint NOT NULL,
	"stripe_meter_event_id" text,
	"reported_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"comped_by" text,
	"intervention_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_entries_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "usage_entries_type_check" CHECK ("type" in ('trial_fee', 'managed_tokens', 'adjustment', 'refund'))
);
--> statement-breakpoint
CREATE TABLE "user_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"kek_version" integer NOT NULL,
	"last4" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_secrets_owner_provider_uq" UNIQUE("owner_id","provider")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_login" text NOT NULL,
	"github_id" bigint NOT NULL,
	"github_created_at" timestamp with time zone,
	"email" text,
	"is_admin_cache" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_login_unique" UNIQUE("github_login"),
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"payload" jsonb NOT NULL,
	CONSTRAINT "webhook_inbox_provider_event_uq" UNIQUE("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_channels" ADD CONSTRAINT "alert_channels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_channel_id_alert_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."alert_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_key_alert_rules_key_fk" FOREIGN KEY ("rule_key") REFERENCES "public"."alert_rules"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottlenecks" ADD CONSTRAINT "bottlenecks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_trial_id_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contenders" ADD CONSTRAINT "contenders_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contenders" ADD CONSTRAINT "contenders_kit_id_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."kits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_intervention_id_interventions_id_fk" FOREIGN KEY ("intervention_id") REFERENCES "public"."interventions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embed_views" ADD CONSTRAINT "embed_views_benchmark_id_published_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."published_benchmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_kit_id_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."kits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_versions" ADD CONSTRAINT "publish_versions_benchmark_id_published_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."published_benchmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_benchmarks" ADD CONSTRAINT "published_benchmarks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_benchmarks" ADD CONSTRAINT "published_benchmarks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_trial_id_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_review_session_id_agent_sessions_id_fk" FOREIGN KEY ("review_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_kit_id_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."kits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_comp_intervention_id_interventions_id_fk" FOREIGN KEY ("comp_intervention_id") REFERENCES "public"."interventions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_contender_id_contenders_id_fk" FOREIGN KEY ("contender_id") REFERENCES "public"."contenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD CONSTRAINT "usage_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD CONSTRAINT "usage_entries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD CONSTRAINT "usage_entries_trial_id_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD CONSTRAINT "usage_entries_intervention_id_interventions_id_fk" FOREIGN KEY ("intervention_id") REFERENCES "public"."interventions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secrets" ADD CONSTRAINT "user_secrets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_run_id_idx" ON "agent_sessions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "alert_channels_owner_id_idx" ON "alert_channels" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_fingerprint_unresolved_uq" ON "alerts" USING btree ("fingerprint") WHERE "alerts"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "alerts_run_id_idx" ON "alerts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "api_keys_owner_id_idx" ON "api_keys" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "bottlenecks_run_id_idx" ON "bottlenecks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "computers_status_idx" ON "computers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "contenders_run_id_idx" ON "contenders" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "cost_entries_run_id_idx" ON "cost_entries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "cost_entries_at_idx" ON "cost_entries" USING btree ("at");--> statement-breakpoint
CREATE INDEX "credit_grants_user_id_idx" ON "credit_grants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_one_signup_per_user_uq" ON "credit_grants" USING btree ("user_id") WHERE "credit_grants"."source" = 'signup';--> statement-breakpoint
CREATE INDEX "events_owner_id_idx" ON "events" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "events_at_idx" ON "events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "interventions_run_id_idx" ON "interventions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "interventions_user_id_idx" ON "interventions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kill_switches_active_uq" ON "kill_switches" USING btree ("scope",coalesce("scope_id", '')) WHERE "kill_switches"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "kits_owner_id_idx" ON "kits" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_email_idx" ON "leads" USING btree ("email");--> statement-breakpoint
CREATE INDEX "outreach_messages_lead_id_idx" ON "outreach_messages" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "projects_owner_id_idx" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "published_benchmarks_owner_id_idx" ON "published_benchmarks" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "reviews_trial_id_idx" ON "reviews" USING btree ("trial_id");--> statement-breakpoint
CREATE INDEX "reviews_owner_id_idx" ON "reviews" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "runs_owner_id_idx" ON "runs" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "runs_state_idx" ON "runs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trials_owner_id_idx" ON "trials" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "trials_run_state_idx" ON "trials" USING btree ("run_id","state");--> statement-breakpoint
CREATE INDEX "trials_lease_idx" ON "trials" USING btree ("lease_until") WHERE "trials"."lease_until" is not null;--> statement-breakpoint
CREATE INDEX "usage_entries_user_id_idx" ON "usage_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_entries_run_id_idx" ON "usage_entries" USING btree ("run_id");