CREATE TYPE "public"."doc_source_type" AS ENUM('openapi', 'markdown', 'llms_txt', 'html', 'graphql', 'postgres', 'file_upload');--> statement-breakpoint
CREATE TYPE "public"."approval_kind" AS ENUM('commit_draft', 'external_write', 'other');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."discovery_artifact_kind" AS ENUM('connector', 'skill', 'knowledge_source');--> statement-breakpoint
CREATE TYPE "public"."discovery_artifact_status" AS ENUM('proposed', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."discovery_run_status" AS ENUM('pending', 'analyzing', 'synthesizing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_refresh" AS ENUM('manual', 'scheduled', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_scope" AS ENUM('global', 'workflow');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_status" AS ENUM('active', 'inactive', 'processing', 'error');--> statement-breakpoint
CREATE TYPE "public"."skill_candidate_confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."skill_candidate_pattern" AS ENUM('repair_pattern', 'failure_pattern', 'success_pattern');--> statement-breakpoint
CREATE TYPE "public"."skill_candidate_status" AS ENUM('proposed', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."autoheal_policy" AS ENUM('safe-patches', 'never-auto', 'dry-run-gate');--> statement-breakpoint
CREATE TABLE "chat_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"workspace_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text,
	"path" text,
	"content" text NOT NULL,
	"byte_size" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"tsv" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"source_type" "doc_source_type" NOT NULL,
	"source_uri" text NOT NULL,
	"version" text NOT NULL,
	"bytes_total" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connector_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"driver" text NOT NULL,
	"base_url" text NOT NULL,
	"auth_type" text NOT NULL,
	"oauth" jsonb,
	"default_skill" text,
	"ingestion_source" text NOT NULL,
	"ingestion_url" text,
	"icon" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"setup_hint" text,
	"auth_options" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"state" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tool_call_id" uuid,
	"kind" "approval_kind" NOT NULL,
	"summary" text NOT NULL,
	"diff" jsonb,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"ordinal" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "discovery_artifact_kind" NOT NULL,
	"status" "discovery_artifact_status" DEFAULT 'proposed' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"draft" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"confidence" integer,
	"materialized_id" text,
	"materialized_type" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text,
	"byte_size" integer NOT NULL,
	"format" text NOT NULL,
	"content" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid,
	"status" "discovery_run_status" DEFAULT 'pending' NOT NULL,
	"label" text,
	"file_count" integer DEFAULT 0 NOT NULL,
	"files_analyzed" integer DEFAULT 0 NOT NULL,
	"artifact_count" integer DEFAULT 0 NOT NULL,
	"token_usage" jsonb DEFAULT '{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}'::jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_login_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"state" text NOT NULL,
	"code_verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"redirect_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"knowledge_source_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text,
	"path" text,
	"content" text NOT NULL,
	"byte_size" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"tsv" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"scope" "knowledge_source_scope" DEFAULT 'global' NOT NULL,
	"workflow_id" uuid,
	"status" "knowledge_source_status" DEFAULT 'active' NOT NULL,
	"source_type" text NOT NULL,
	"source_uri" text NOT NULL,
	"mime_type" text,
	"version" text NOT NULL,
	"bytes_total" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"refresh_strategy" "knowledge_source_refresh" DEFAULT 'manual' NOT NULL,
	"refresh_cron" text,
	"refresh_webhook_secret" text,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flow" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"result" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"month_bucket" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_llm_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"llm_primary_model" text,
	"llm_fallback_model" text,
	"llm_provider" text,
	"llm_provider_credentials_ciphertext" "bytea",
	"llm_provider_credentials_iv" "bytea",
	"llm_provider_credentials_auth_tag" "bytea",
	"llm_monthly_token_budget" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"platform" text NOT NULL,
	"default_severity" text DEFAULT 'info' NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 60 NOT NULL,
	"circuit_state" text DEFAULT 'closed' NOT NULL,
	"circuit_open_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid,
	"channel_id" uuid,
	"event_type" text NOT NULL,
	"event_payload" jsonb,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"event_pattern" text NOT NULL,
	"workflow_pattern" text DEFAULT '*' NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"request_source_filter" jsonb,
	"target_workspace_id" text NOT NULL,
	"target_channel_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "group_role_assignments" (
	"group_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "group_role_assignments_group_id_role_id_pk" PRIMARY KEY("group_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"resource_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_candidate_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_candidate_id" uuid NOT NULL,
	"execution_id" uuid,
	"patch_candidate_id" uuid,
	"evidence_type" text NOT NULL,
	"summary" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" "skill_scope" NOT NULL,
	"connector_id" uuid,
	"workflow_id" uuid,
	"pattern_kind" "skill_candidate_pattern" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"examples" jsonb,
	"evidence" jsonb NOT NULL,
	"confidence" "skill_candidate_confidence" NOT NULL,
	"status" "skill_candidate_status" DEFAULT 'proposed' NOT NULL,
	"promoted_skill_id" uuid,
	"fingerprint" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_effectiveness" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"skill_candidate_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"executions_before" integer NOT NULL,
	"failures_before" integer NOT NULL,
	"executions_after" integer NOT NULL,
	"failures_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_replay_seen" (
	"tenant_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"standard_webhook_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_autoheal_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"policy" "autoheal_policy" DEFAULT 'safe-patches' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "connectors_tenant_slug_key";--> statement-breakpoint
/* 
    Unfortunately in current drizzle-kit version we can't automatically get name for primary key.
    We are working on making it available!

    Meanwhile you can:
        1. Check pk name in your database, by running
            SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema = 'public'
                AND table_name = 'outbox_cursors'
                AND constraint_type = 'PRIMARY KEY';
        2. Uncomment code below and paste pk name manually
        
    Hope to release this update as soon as possible
*/

-- ALTER TABLE "outbox_cursors" DROP CONSTRAINT "<constraint_name>";--> statement-breakpoint
ALTER TABLE "execution_fixtures" ALTER COLUMN "connector_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ALTER COLUMN "endpoint_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ALTER COLUMN "request" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ALTER COLUMN "response" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_cursors" ADD CONSTRAINT "outbox_cursors_listener_id_channel_pk" PRIMARY KEY("listener_id","channel");--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "environment" "environment" DEFAULT 'dev' NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "auth_type" "credential_mode" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "dsn" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "auto_refresh_cron" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "last_ingested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "memory" text;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD COLUMN "kind" text DEFAULT 'fixture' NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD COLUMN "execution_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD COLUMN "step_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD COLUMN "body" jsonb;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD COLUMN "byte_size" integer;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "step_index" integer;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "result_storage_uri" text;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "result_preview" text;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "request_meta" jsonb;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "rotating_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "absolute_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "token_sha256" text;--> statement-breakpoint
ALTER TABLE "system_accounts" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "external_subject" text;--> statement-breakpoint
ALTER TABLE "request_hooks" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "request_hooks" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "arguments" jsonb;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "outbox_event_id" bigint;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "attempt_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "event_type" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "target_url" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "response_body" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "rotating_secret_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "rotating_secret_iv" "bytea";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "rotating_secret_auth_tag" "bytea";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "circuit_open_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks_inbound" ADD COLUMN "native_verifier_config" jsonb;--> statement-breakpoint
ALTER TABLE "workflows_schedules" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "chat_link_tokens" ADD CONSTRAINT "chat_link_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_link_tokens" ADD CONSTRAINT "chat_link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_document_chunks" ADD CONSTRAINT "connector_document_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_document_chunks" ADD CONSTRAINT "connector_document_chunks_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_document_chunks" ADD CONSTRAINT "connector_document_chunks_document_id_connector_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."connector_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_documents" ADD CONSTRAINT "connector_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_documents" ADD CONSTRAINT "connector_documents_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_templates" ADD CONSTRAINT "connector_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tool_call_id_conversation_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."conversation_tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_drafts" ADD CONSTRAINT "conversation_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_drafts" ADD CONSTRAINT "conversation_drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_artifacts" ADD CONSTRAINT "discovery_artifacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_artifacts" ADD CONSTRAINT "discovery_artifacts_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_files" ADD CONSTRAINT "discovery_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_files" ADD CONSTRAINT "discovery_files_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_knowledge_source_id_knowledge_sources_id_fk" FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_llm_settings" ADD CONSTRAINT "tenant_llm_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_rule_id_notification_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."notification_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_role_assignments" ADD CONSTRAINT "group_role_assignments_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_role_assignments" ADD CONSTRAINT "group_role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidate_evidence" ADD CONSTRAINT "skill_candidate_evidence_skill_candidate_id_skill_candidates_id_fk" FOREIGN KEY ("skill_candidate_id") REFERENCES "public"."skill_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidates" ADD CONSTRAINT "skill_candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidates" ADD CONSTRAINT "skill_candidates_promoted_skill_id_skills_id_fk" FOREIGN KEY ("promoted_skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_effectiveness" ADD CONSTRAINT "skill_effectiveness_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_effectiveness" ADD CONSTRAINT "skill_effectiveness_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_effectiveness" ADD CONSTRAINT "skill_effectiveness_skill_candidate_id_skill_candidates_id_fk" FOREIGN KEY ("skill_candidate_id") REFERENCES "public"."skill_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_replay_seen" ADD CONSTRAINT "webhook_replay_seen_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_replay_seen" ADD CONSTRAINT "webhook_replay_seen_webhook_id_webhooks_inbound_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks_inbound"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_autoheal_policies" ADD CONSTRAINT "workflow_autoheal_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_autoheal_policies" ADD CONSTRAINT "workflow_autoheal_policies_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_link_tokens_token_key" ON "chat_link_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "connector_document_chunks_tenant_connector_ordinal_idx" ON "connector_document_chunks" USING btree ("tenant_id","connector_id","ordinal");--> statement-breakpoint
CREATE INDEX "connector_documents_tenant_connector_idx" ON "connector_documents" USING btree ("tenant_id","connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_templates_tenant_slug_key" ON "connector_templates" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_oauth_states_state_key" ON "connector_oauth_states" USING btree ("state");--> statement-breakpoint
CREATE INDEX "approval_requests_conv_status_idx" ON "approval_requests" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "conversation_drafts_conv_ordinal_idx" ON "conversation_drafts" USING btree ("conversation_id","ordinal");--> statement-breakpoint
CREATE INDEX "discovery_artifacts_run_kind_idx" ON "discovery_artifacts" USING btree ("run_id","kind");--> statement-breakpoint
CREATE INDEX "discovery_artifacts_tenant_status_idx" ON "discovery_artifacts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "discovery_files_run_idx" ON "discovery_files" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "discovery_runs_tenant_status_idx" ON "discovery_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_login_states_state_key" ON "oidc_login_states" USING btree ("state");--> statement-breakpoint
CREATE INDEX "oidc_login_states_expires_idx" ON "oidc_login_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tenant_source_ordinal_idx" ON "knowledge_chunks" USING btree ("tenant_id","knowledge_source_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_tenant_slug_key" ON "knowledge_sources" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "knowledge_sources_tenant_idx" ON "knowledge_sources" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_tenant_scope_idx" ON "knowledge_sources" USING btree ("tenant_id","scope");--> statement-breakpoint
CREATE INDEX "knowledge_sources_tenant_workflow_idx" ON "knowledge_sources" USING btree ("tenant_id","workflow_id");--> statement-breakpoint
CREATE INDEX "llm_usage_tenant_created_idx" ON "llm_usage" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_tenant_month_idx" ON "llm_usage" USING btree ("tenant_id","month_bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_llm_settings_tenant_key" ON "tenant_llm_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "notification_channels_tenant_ws_channel_idx" ON "notification_channels" USING btree ("tenant_id","workspace_id","channel_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_tenant_status_idx" ON "notification_deliveries" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "notification_rules_tenant_event_idx" ON "notification_rules" USING btree ("tenant_id","event_pattern");--> statement-breakpoint
CREATE INDEX "notification_rules_tenant_target_idx" ON "notification_rules" USING btree ("tenant_id","target_workspace_id","target_channel_id");--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "group_role_assignments_role_idx" ON "group_role_assignments" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_tenant_name_key" ON "groups" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_name_key" ON "permissions" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_grants_unique_key" ON "resource_grants" USING btree ("tenant_id","subject_type","subject_id","resource_type","resource_id","permission_id");--> statement-breakpoint
CREATE INDEX "resource_grants_subject_idx" ON "resource_grants" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "resource_grants_resource_idx" ON "resource_grants" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "role_permissions_role_idx" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "role_permissions_permission_idx" ON "role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_key" ON "roles" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "skill_candidate_evidence_candidate_idx" ON "skill_candidate_evidence" USING btree ("skill_candidate_id");--> statement-breakpoint
CREATE INDEX "skill_candidates_tenant_status_idx" ON "skill_candidates" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "skill_candidates_tenant_connector_idx" ON "skill_candidates" USING btree ("tenant_id","connector_id");--> statement-breakpoint
CREATE INDEX "skill_candidates_tenant_workflow_idx" ON "skill_candidates" USING btree ("tenant_id","workflow_id");--> statement-breakpoint
CREATE INDEX "skill_candidates_tenant_fingerprint_idx" ON "skill_candidates" USING btree ("tenant_id","fingerprint");--> statement-breakpoint
CREATE INDEX "skill_effectiveness_tenant_skill_idx" ON "skill_effectiveness" USING btree ("tenant_id","skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_replay_seen_key" ON "webhook_replay_seen" USING btree ("tenant_id","webhook_id","standard_webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_replay_seen_seen_at_idx" ON "webhook_replay_seen" USING btree ("seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_autoheal_policies_workflow_key" ON "workflow_autoheal_policies" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_autoheal_policies_tenant_idx" ON "workflow_autoheal_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_tenant_slug_env_key" ON "connectors" USING btree ("tenant_id","slug","environment");--> statement-breakpoint
CREATE INDEX "conversations_owner_idx" ON "conversations" USING btree ("tenant_id","owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "execution_fixtures_kind_idx" ON "execution_fixtures" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "execution_fixtures_execution_idx" ON "execution_fixtures" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "api_keys_rotating_out_at_idx" ON "api_keys" USING btree ("rotating_out_at");--> statement-breakpoint
CREATE INDEX "sessions_absolute_expires_idx" ON "sessions" USING btree ("absolute_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_last_seen_idx" ON "sessions" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "sessions_token_sha256_idx" ON "sessions" USING btree ("token_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_external_subject_key" ON "users" USING btree ("tenant_id","external_subject");