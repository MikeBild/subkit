CREATE TYPE "public"."chat_platform" AS ENUM('slack', 'teams', 'google_chat');--> statement-breakpoint
CREATE TYPE "public"."doc_source_type" AS ENUM('openapi', 'markdown', 'llms_txt', 'html', 'graphql', 'postgres', 'file_upload');--> statement-breakpoint
CREATE TYPE "public"."connector_template_source" AS ENUM('builtin', 'tenant');--> statement-breakpoint
CREATE TYPE "public"."credential_mode" AS ENUM('none', 'header', 'query', 'bearer', 'basic', 'oauth2', 'aws_sigv4', 'token_mint', 'oauth2_client');--> statement-breakpoint
CREATE TYPE "public"."end_user_combine_mode" AS ENUM('merge', 'replace');--> statement-breakpoint
CREATE TYPE "public"."environment" AS ENUM('dev', 'prod');--> statement-breakpoint
CREATE TYPE "public"."elicitation_status" AS ENUM('pending', 'resolved', 'cancelled', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."conversation_role" AS ENUM('user', 'assistant', 'tool', 'system');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'awaiting_input', 'committed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."discovery_artifact_kind" AS ENUM('connector', 'skill', 'knowledge_source');--> statement-breakpoint
CREATE TYPE "public"."discovery_artifact_status" AS ENUM('proposed', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."discovery_run_status" AS ENUM('pending', 'analyzing', 'synthesizing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."execution_mode" AS ENUM('dev', 'prod');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'aborted', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."patch_classification" AS ENUM('safe', 'unsafe');--> statement-breakpoint
CREATE TYPE "public"."patch_status" AS ENUM('proposed', 'applied', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."file_link_resource" AS ENUM('conversation', 'knowledge_source', 'skill', 'connector', 'workflow_run', 'discovery_run');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('pending', 'uploading', 'scanning', 'ready', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_kind" AS ENUM('user', 'system_account', 'system');--> statement-breakpoint
CREATE TYPE "public"."egress_guard_mode" AS ENUM('strict', 'permissive');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member', 'enduser');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_refresh" AS ENUM('manual', 'scheduled', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_scope" AS ENUM('global', 'workflow');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_status" AS ENUM('active', 'inactive', 'processing', 'error');--> statement-breakpoint
CREATE TYPE "public"."skill_candidate_confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."skill_candidate_pattern" AS ENUM('repair_pattern', 'failure_pattern', 'success_pattern', 'chained_workflow_pattern');--> statement-breakpoint
CREATE TYPE "public"."skill_candidate_status" AS ENUM('proposed', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."skill_lifecycle" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."skill_scope" AS ENUM('global', 'connector', 'workflow');--> statement-breakpoint
CREATE TYPE "public"."skill_source" AS ENUM('manual', 'candidate', 'template', 'memory');--> statement-breakpoint
CREATE TYPE "public"."autoheal_policy" AS ENUM('safe-patches', 'never-auto', 'dry-run-gate');--> statement-breakpoint
CREATE TYPE "public"."workflow_lifecycle" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"result" text NOT NULL,
	"trace_id" text,
	"ip" text,
	"user_agent" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("audit_log"."actor_type" IN ('user','system_account','system')),
	CONSTRAINT "audit_log_result_check" CHECK ("audit_log"."result" IN ('success','denied','error'))
);
--> statement-breakpoint
CREATE TABLE "chat_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_events_seen" (
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform_event_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"workspace_id" text NOT NULL,
	"platform_user_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" "chat_platform" NOT NULL,
	"workspace_id" text NOT NULL,
	"default_channel" text,
	"bot_ciphertext" "bytea" NOT NULL,
	"bot_iv" "bytea" NOT NULL,
	"bot_auth_tag" "bytea" NOT NULL,
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
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', (((COALESCE(title, '') || ' ') || COALESCE(path, '')) || ' ') || content)) STORED,
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
CREATE TABLE "connector_template_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_slug" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"setup_instructions" text DEFAULT '' NOT NULL,
	"auth_options" jsonb DEFAULT '[]'::jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"url_pattern" text DEFAULT '' NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inline_schema" jsonb,
	"probe_endpoint" jsonb,
	"credential_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_url_options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pagination_defaults" jsonb,
	"capabilities" jsonb DEFAULT '{"webhooks":false,"webhook_events":[],"rate_limits":null}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_endpoint_schemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"path" text NOT NULL,
	"method" text NOT NULL,
	"request_schema" jsonb,
	"query_schema" jsonb,
	"response_schema" jsonb,
	"expected_statuses" integer[],
	"idempotent" boolean DEFAULT false NOT NULL,
	"description" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"overrides" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_oauth_start_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"token_sha256" text NOT NULL,
	"created_by_actor_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_scopes" text
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"driver" text NOT NULL,
	"environment" "environment" DEFAULT 'dev' NOT NULL,
	"auth_type" "credential_mode" DEFAULT 'none' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"base_url" text,
	"dsn" text,
	"operator_quirks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"template_slug" text,
	"template_name" text,
	"template_source" "connector_template_source",
	"template_version" integer,
	"template_snapshot" jsonb,
	"auto_refresh_cron" text,
	"last_ingested_at" timestamp with time zone,
	"circuit_state" text DEFAULT 'closed' NOT NULL,
	"circuit_opened_at" timestamp with time zone,
	"circuit_failure_count" integer DEFAULT 0 NOT NULL,
	"circuit_threshold" integer DEFAULT 5 NOT NULL,
	"circuit_reset_ms" integer DEFAULT 300000 NOT NULL,
	"needs_reauth" boolean DEFAULT false NOT NULL,
	"auth_failed_at" timestamp with time zone,
	"auth_failed_reason" text,
	"health_state" text DEFAULT 'ok' NOT NULL,
	"health_reason" text,
	"health_error_code" text,
	"health_changed_at" timestamp with time zone,
	"sunset_at" timestamp with time zone,
	"successor_uri" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid,
	"mcp_server_id" uuid,
	"environment" "environment" NOT NULL,
	"mode" "credential_mode" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"oauth2_refresh_ciphertext" "bytea",
	"oauth2_refresh_iv" "bytea",
	"oauth2_refresh_auth_tag" "bytea",
	"oauth2_expires_at" timestamp with time zone,
	"granted_scopes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_owner_xor_check" CHECK (("credentials"."connector_id" IS NOT NULL) <> ("credentials"."mcp_server_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "end_user_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"enduser_ref" text NOT NULL,
	"combine_mode" "end_user_combine_mode" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schema_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"endpoint_key" text NOT NULL,
	"schema" jsonb NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_elicitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tool_call_id" uuid,
	"parent_message_id" uuid,
	"tool_name" text NOT NULL,
	"summary" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"status" "elicitation_status" DEFAULT 'pending' NOT NULL,
	"protocol_native" boolean DEFAULT false NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "conversation_role" NOT NULL,
	"content" jsonb NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"parent_message_id" uuid,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"approval_required" boolean DEFAULT false NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"confirmation_state" text,
	"confirmation_data" jsonb,
	"interaction_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_workflow_id" uuid,
	"target_connector_id" uuid,
	"draft" jsonb,
	"status" "conversation_status" NOT NULL,
	"owner_id" uuid,
	"model" text,
	"title" text,
	"memory" text,
	"loaded_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_policies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_draft_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_index" integer NOT NULL,
	"draft" jsonb NOT NULL,
	"label" text,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "data_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_cursors" (
	"listener_id" text NOT NULL,
	"channel" text NOT NULL,
	"last_seen_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_cursors_listener_id_channel_pk" PRIMARY KEY("listener_id","channel")
);
--> statement-breakpoint
CREATE TABLE "execution_fixtures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid,
	"endpoint_key" text,
	"request" jsonb,
	"response" jsonb,
	"kind" text DEFAULT 'fixture' NOT NULL,
	"execution_id" uuid,
	"step_id" uuid,
	"body" jsonb,
	"byte_size" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"step_index" integer,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"input_preview" jsonb,
	"output_preview" jsonb,
	"result_storage_uri" text,
	"result_preview" text,
	"request_meta" jsonb,
	"duration_ms" integer,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"placeholders_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redacted_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid,
	"workflow_version_id" uuid,
	"source_kind" text DEFAULT 'saved' NOT NULL,
	"source_ref" jsonb,
	"input" jsonb,
	"status" "execution_status" NOT NULL,
	"request_source" text NOT NULL,
	"execution_mode" "execution_mode" NOT NULL,
	"parent_execution_id" uuid,
	"result_storage_uri" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"connector_id" uuid,
	"endpoint_key" text,
	"diff" jsonb NOT NULL,
	"classification" "patch_classification" NOT NULL,
	"fixture_id" uuid,
	"status" "patch_status" NOT NULL,
	"outcome_window_ended_at" timestamp with time zone,
	"outcome_successes_after" integer DEFAULT 0 NOT NULL,
	"outcome_failures_after" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_call_metering" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"operation" text,
	"units" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"result" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"month_bucket" bigint NOT NULL,
	CONSTRAINT "external_call_metering_result_check" CHECK ("external_call_metering"."result" IN ('ok','error')),
	CONSTRAINT "external_call_metering_provider_slug_check" CHECK ("external_call_metering"."provider" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "file_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"resource_type" "file_link_resource" NOT NULL,
	"resource_id" uuid NOT NULL,
	"slug" text,
	"role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" "file_status" DEFAULT 'pending' NOT NULL,
	"filename" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_uri" text NOT NULL,
	"sha256" text,
	"upload_url_expires_at" timestamp with time zone,
	"scan_result" text,
	"anthropic_file_id" text,
	"openai_file_id" text,
	"gemini_file_id" text,
	"llm_file_expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "files_dedup_seen" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"system_account_id" uuid,
	"prefix" text NOT NULL,
	"token_sha256" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"allowed_workflows" jsonb,
	"allowed_connectors" jsonb,
	"not_before" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"rotating_out_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"rotated_from_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"priority" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config_ciphertext" "bytea",
	"config_iv" "bytea",
	"config_auth_tag" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engine_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
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
CREATE TABLE "portal_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"enduser_ref" text NOT NULL,
	"prefix" text NOT NULL,
	"token_sha256" text NOT NULL,
	"allowed_workflows" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"absolute_expires_at" timestamp with time zone,
	"token_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"role_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"llm_primary" text,
	"llm_fallback" text,
	"llm_monthly_token_budget" bigint,
	"egress_guard_mode" "egress_guard_mode",
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"last_proactive_scan_at" timestamp with time zone,
	"last_skill_candidate_analyze_at" timestamp with time zone,
	"last_connector_reauth_scan_at" timestamp with time zone,
	"last_endpoint_contract_scan_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" NOT NULL,
	"role_id" uuid,
	"oidc_subject" text,
	"external_subject" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', (COALESCE(title, '') || ' ') || content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"scope" "knowledge_source_scope" DEFAULT 'global' NOT NULL,
	"workflow_id" uuid,
	"status" "knowledge_source_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"source_type" text NOT NULL,
	"source_uri" text NOT NULL,
	"file_id" uuid,
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
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"result" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"month_bucket" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_dlp_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"path_match" text NOT NULL,
	"pattern_regex" text,
	"action" text NOT NULL,
	"reason" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"enable_prompt_cache" boolean DEFAULT true NOT NULL,
	"system_prompt_additions" text,
	"default_environment" text DEFAULT 'dev' NOT NULL,
	"auto_discovery" boolean DEFAULT true NOT NULL,
	"failure_notification_channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmation_profile" text DEFAULT 'strict' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_recipe_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client" text NOT NULL,
	"override" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"token_sha256" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"refresh_token_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_authorization_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"code_sha256" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"state" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_authorization_codes_code_challenge_method_check" CHECK ("mcp_oauth_authorization_codes"."code_challenge_method" = 'S256')
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_types" jsonb DEFAULT '["authorization_code", "refresh_token"]'::jsonb NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"scope" text DEFAULT 'mcp:read' NOT NULL,
	"client_name" text,
	"software_id" text,
	"registration_source" text DEFAULT 'dcr' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_clients_token_endpoint_auth_method_check" CHECK ("mcp_oauth_clients"."token_endpoint_auth_method" = 'none'),
	CONSTRAINT "mcp_oauth_clients_registration_source_check" CHECK ("mcp_oauth_clients"."registration_source" IN ('dcr','manual'))
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"token_sha256" text NOT NULL,
	"scope" text NOT NULL,
	"rotated_to_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"state" text NOT NULL,
	"code_verifier" text DEFAULT '' NOT NULL,
	"redirect_uri" text NOT NULL,
	"authorization_url" text,
	"as_issuer" text,
	"requested_scopes" text,
	"started_by_actor_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"namespace" text NOT NULL,
	"transport" text NOT NULL,
	"url" text NOT NULL,
	"auth_config" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"last_handshake_at" timestamp with time zone,
	"last_error" text,
	"tools_manifest_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_transport_check" CHECK ("mcp_servers"."transport" IN ('http','sse','stdio')),
	CONSTRAINT "mcp_servers_status_check" CHECK ("mcp_servers"."status" IN ('active','disabled','error')),
	CONSTRAINT "mcp_servers_namespace_shape_check" CHECK ("mcp_servers"."namespace" ~ '^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$' AND "mcp_servers"."namespace" !~ '__'),
	CONSTRAINT "mcp_servers_auth_config_no_inline_secrets_check" CHECK ("mcp_servers"."auth_config" IS NULL OR NOT (
        "mcp_servers"."auth_config" ? 'client_secret' OR
        "mcp_servers"."auth_config" ? 'password' OR
        "mcp_servers"."auth_config" ? 'passphrase' OR
        "mcp_servers"."auth_config" ? 'api_key' OR
        "mcp_servers"."auth_config" ? 'apikey' OR
        "mcp_servers"."auth_config" ? 'access_token' OR
        "mcp_servers"."auth_config" ? 'refresh_token' OR
        "mcp_servers"."auth_config" ? 'bearer_token' OR
        "mcp_servers"."auth_config" ? 'secret'
      ))
);
--> statement-breakpoint
CREATE TABLE "mcp_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_seq" integer NOT NULL,
	"kind" text NOT NULL,
	"job_id" text,
	"request_source" text,
	"actor_id" uuid,
	"user_message_id" uuid,
	"result" jsonb,
	"failure_reason" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tasks_kind_check" CHECK ("mcp_tasks"."kind" IN ('start','append','respond_elicitation'))
);
--> statement-breakpoint
CREATE TABLE "cli_notification_inbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delivery_id" uuid,
	"severity" text NOT NULL,
	"event_type" text NOT NULL,
	"event_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "request_hooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" text NOT NULL,
	"source" text NOT NULL,
	"description" text,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"stdlib_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "self_healing_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"filters" jsonb NOT NULL,
	"actor_id" uuid,
	"idempotency_key" text,
	"signals_detected" integer DEFAULT 0 NOT NULL,
	"candidates_created" integer DEFAULT 0 NOT NULL,
	"unanchored_detected" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"status" text NOT NULL,
	"error" text,
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
	"endpoint_key" text,
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
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" "skill_scope" NOT NULL,
	"connector_id" uuid,
	"workflow_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"examples" jsonb,
	"arguments" jsonb,
	"lifecycle" "skill_lifecycle" NOT NULL,
	"source" "skill_source" DEFAULT 'manual' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"seed_source" text,
	"slug" text,
	"gates_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"activates_when" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"side_effects" text DEFAULT 'read' NOT NULL,
	"idempotency" text DEFAULT 'none' NOT NULL,
	"maturity" text DEFAULT 'stable' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_idempotency_chk" CHECK ("skills"."idempotency" IN ('none','naturally','key_required')),
	CONSTRAINT "skills_maturity_chk" CHECK ("skills"."maturity" IN ('experimental','stable')),
	CONSTRAINT "skills_side_effects_chk" CHECK ("skills"."side_effects" IN ('none','read','write','destructive'))
);
--> statement-breakpoint
CREATE TABLE "tenant_skill_overrides" (
	"tenant_id" uuid NOT NULL,
	"skill_slug" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"body_override" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"outbox_event_id" bigint,
	"attempt" integer NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"response_code" integer,
	"error" text,
	"classification" text,
	"terminal_reason" text,
	"request_hash" text,
	"event_type" text,
	"target_url" text,
	"response_body" text,
	"duration_ms" integer,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_pattern" text NOT NULL,
	"target_url" text NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_iv" "bytea" NOT NULL,
	"secret_auth_tag" "bytea" NOT NULL,
	"rotating_secret_ciphertext" "bytea",
	"rotating_secret_iv" "bytea",
	"rotating_secret_auth_tag" "bytea",
	"filters" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"circuit_open_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_replay_seen" (
	"tenant_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"standard_webhook_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks_inbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"verifier" text NOT NULL,
	"native_verifier_config" jsonb,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_iv" "bytea" NOT NULL,
	"secret_auth_tag" "bytea" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"origin" text DEFAULT 'crud' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks_outbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscription_id" uuid,
	"signing_keys" jsonb NOT NULL,
	"circuit_state" text DEFAULT 'closed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_run_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"key" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"value_kind" text,
	"note" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_waits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"sleep_until_ts" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"dag" jsonb NOT NULL,
	"author_user_id" uuid,
	"author_system_account_id" uuid,
	"note" text,
	"scope_index" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"current_version_id" uuid,
	"lifecycle" "workflow_lifecycle" NOT NULL,
	"is_tool" boolean DEFAULT true NOT NULL,
	"last_executed_at" timestamp with time zone,
	"health_state" text DEFAULT 'ok' NOT NULL,
	"health_reason" text,
	"health_changed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"input" jsonb,
	"last_enqueued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_workspace_id_chat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."chat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_events_seen" ADD CONSTRAINT "chat_events_seen_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_events_seen" ADD CONSTRAINT "chat_events_seen_workspace_id_chat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."chat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_identities" ADD CONSTRAINT "chat_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_identities" ADD CONSTRAINT "chat_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_workspace_id_chat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."chat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_workspaces" ADD CONSTRAINT "chat_workspaces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_document_chunks" ADD CONSTRAINT "connector_document_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_document_chunks" ADD CONSTRAINT "connector_document_chunks_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_document_chunks" ADD CONSTRAINT "connector_document_chunks_document_id_connector_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."connector_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_documents" ADD CONSTRAINT "connector_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_documents" ADD CONSTRAINT "connector_documents_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_template_credentials" ADD CONSTRAINT "connector_template_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_templates" ADD CONSTRAINT "connector_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_endpoint_schemas" ADD CONSTRAINT "connector_endpoint_schemas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_endpoint_schemas" ADD CONSTRAINT "connector_endpoint_schemas_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_environments" ADD CONSTRAINT "connector_environments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_environments" ADD CONSTRAINT "connector_environments_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_start_grants" ADD CONSTRAINT "connector_oauth_start_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_start_grants" ADD CONSTRAINT "connector_oauth_start_grants_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "end_user_credentials" ADD CONSTRAINT "end_user_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "end_user_credentials" ADD CONSTRAINT "end_user_credentials_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_versions" ADD CONSTRAINT "schema_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_versions" ADD CONSTRAINT "schema_versions_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD CONSTRAINT "conversation_elicitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD CONSTRAINT "conversation_elicitations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD CONSTRAINT "conversation_elicitations_tool_call_id_conversation_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."conversation_tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD CONSTRAINT "conversation_elicitations_parent_message_id_conversation_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD CONSTRAINT "conversation_elicitations_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_tool_calls" ADD CONSTRAINT "conversation_tool_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_tool_calls" ADD CONSTRAINT "conversation_tool_calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_tool_calls" ADD CONSTRAINT "conversation_tool_calls_parent_message_id_conversation_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_draft_snapshots" ADD CONSTRAINT "conversation_draft_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_draft_snapshots" ADD CONSTRAINT "conversation_draft_snapshots_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_drafts" ADD CONSTRAINT "conversation_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_drafts" ADD CONSTRAINT "conversation_drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_artifacts" ADD CONSTRAINT "discovery_artifacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_artifacts" ADD CONSTRAINT "discovery_artifacts_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_files" ADD CONSTRAINT "discovery_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_files" ADD CONSTRAINT "discovery_files_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD CONSTRAINT "execution_fixtures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD CONSTRAINT "execution_fixtures_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD CONSTRAINT "patch_candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD CONSTRAINT "patch_candidates_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD CONSTRAINT "patch_candidates_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_call_metering" ADD CONSTRAINT "external_call_metering_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_links" ADD CONSTRAINT "file_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_links" ADD CONSTRAINT "file_links_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files_dedup_seen" ADD CONSTRAINT "files_dedup_seen_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_provider_configs" ADD CONSTRAINT "auth_provider_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_tokens" ADD CONSTRAINT "portal_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_accounts" ADD CONSTRAINT "system_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_knowledge_source_id_knowledge_sources_id_fk" FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_dlp_rules" ADD CONSTRAINT "tenant_dlp_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_llm_settings" ADD CONSTRAINT "tenant_llm_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_recipe_overrides" ADD CONSTRAINT "vendor_recipe_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_tokens" ADD CONSTRAINT "mcp_oauth_access_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_tokens" ADD CONSTRAINT "mcp_oauth_access_tokens_refresh_token_id_mcp_oauth_refresh_tokens_id_fk" FOREIGN KEY ("refresh_token_id") REFERENCES "public"."mcp_oauth_refresh_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorization_codes" ADD CONSTRAINT "mcp_oauth_authorization_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_refresh_tokens" ADD CONSTRAINT "mcp_oauth_refresh_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_refresh_tokens" ADD CONSTRAINT "mcp_oauth_refresh_tokens_rotated_to_id_mcp_oauth_refresh_tokens_id_fk" FOREIGN KEY ("rotated_to_id") REFERENCES "public"."mcp_oauth_refresh_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD CONSTRAINT "mcp_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD CONSTRAINT "mcp_tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD CONSTRAINT "mcp_tasks_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD CONSTRAINT "mcp_tasks_user_message_id_conversation_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_notification_inbox" ADD CONSTRAINT "cli_notification_inbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_notification_inbox" ADD CONSTRAINT "cli_notification_inbox_delivery_id_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "request_hooks" ADD CONSTRAINT "request_hooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_healing_scans" ADD CONSTRAINT "self_healing_scans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidate_evidence" ADD CONSTRAINT "skill_candidate_evidence_skill_candidate_id_skill_candidates_id_fk" FOREIGN KEY ("skill_candidate_id") REFERENCES "public"."skill_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidates" ADD CONSTRAINT "skill_candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidates" ADD CONSTRAINT "skill_candidates_promoted_skill_id_skills_id_fk" FOREIGN KEY ("promoted_skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_effectiveness" ADD CONSTRAINT "skill_effectiveness_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_effectiveness" ADD CONSTRAINT "skill_effectiveness_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_effectiveness" ADD CONSTRAINT "skill_effectiveness_skill_candidate_id_skill_candidates_id_fk" FOREIGN KEY ("skill_candidate_id") REFERENCES "public"."skill_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_skill_overrides" ADD CONSTRAINT "tenant_skill_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_replay_seen" ADD CONSTRAINT "webhook_replay_seen_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_replay_seen" ADD CONSTRAINT "webhook_replay_seen_webhook_id_webhooks_inbound_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks_inbound"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks_inbound" ADD CONSTRAINT "webhooks_inbound_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks_inbound" ADD CONSTRAINT "webhooks_inbound_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks_outbound" ADD CONSTRAINT "webhooks_outbound_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks_outbound" ADD CONSTRAINT "webhooks_outbound_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_state" ADD CONSTRAINT "workflow_run_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_state" ADD CONSTRAINT "workflow_run_state_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_signals" ADD CONSTRAINT "workflow_signals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_signals" ADD CONSTRAINT "workflow_signals_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_waits" ADD CONSTRAINT "workflow_waits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_waits" ADD CONSTRAINT "workflow_waits_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_waits" ADD CONSTRAINT "workflow_waits_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_autoheal_policies" ADD CONSTRAINT "workflow_autoheal_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_autoheal_policies" ADD CONSTRAINT "workflow_autoheal_policies_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows_schedules" ADD CONSTRAINT "workflows_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows_schedules" ADD CONSTRAINT "workflows_schedules_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_ts_idx" ON "audit_log" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_action_ts_idx" ON "audit_log" USING btree ("tenant_id","action","ts");--> statement-breakpoint
CREATE INDEX "chat_deliveries_workspace_status_created_idx" ON "chat_deliveries" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_events_seen_key" ON "chat_events_seen" USING btree ("workspace_id","platform_event_id");--> statement-breakpoint
CREATE INDEX "chat_events_seen_seen_at_idx" ON "chat_events_seen" USING btree ("seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_identities_platform_workspace_user_key" ON "chat_identities" USING btree ("platform","workspace_id","platform_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_workspace_thread_key" ON "chat_sessions" USING btree ("workspace_id","thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_workspaces_tenant_platform_workspace_key" ON "chat_workspaces" USING btree ("tenant_id","platform","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_workspaces_platform_workspace_global_key" ON "chat_workspaces" USING btree ("platform","workspace_id");--> statement-breakpoint
CREATE INDEX "connector_document_chunks_tenant_connector_ordinal_idx" ON "connector_document_chunks" USING btree ("tenant_id","connector_id","ordinal");--> statement-breakpoint
CREATE INDEX "connector_document_chunks_tsv_idx" ON "connector_document_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "connector_documents_tenant_connector_idx" ON "connector_documents" USING btree ("tenant_id","connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_template_credentials_tenant_slug_key" ON "connector_template_credentials" USING btree ("tenant_id","template_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_templates_tenant_slug_key" ON "connector_templates" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "connector_endpoint_schemas_tenant_connector_idx" ON "connector_endpoint_schemas" USING btree ("tenant_id","connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conn_ep_schemas_method_path_uq" ON "connector_endpoint_schemas" USING btree ("connector_id","method","path");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_environments_connector_env_key" ON "connector_environments" USING btree ("connector_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_oauth_start_grants_token_sha256_key" ON "connector_oauth_start_grants" USING btree ("token_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_oauth_states_state_key" ON "connector_oauth_states" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_tenant_slug_env_key" ON "connectors" USING btree ("tenant_id","slug","environment") WHERE "connectors"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "connectors_needs_reauth_idx" ON "connectors" USING btree ("tenant_id") WHERE "connectors"."needs_reauth" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_connector_env_mode_key" ON "credentials" USING btree ("connector_id","environment","mode") WHERE "credentials"."connector_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_mcp_server_env_mode_key" ON "credentials" USING btree ("mcp_server_id","environment","mode") WHERE "credentials"."mcp_server_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "end_user_credentials_unique_key" ON "end_user_credentials" USING btree ("tenant_id","connector_id","enduser_ref");--> statement-breakpoint
CREATE INDEX "schema_versions_connector_endpoint_seen_idx" ON "schema_versions" USING btree ("connector_id","endpoint_key","seen_at");--> statement-breakpoint
CREATE INDEX "conversation_elicitations_conv_status_idx" ON "conversation_elicitations" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "conversation_elicitations_parent_msg_idx" ON "conversation_elicitations" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_conv_created_idx" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_tool_calls_conv_created_idx" ON "conversation_tool_calls" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_tool_calls_parent_msg_idx" ON "conversation_tool_calls" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "conversations_tenant_status_idx" ON "conversations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "conversations_owner_idx" ON "conversations" USING btree ("tenant_id","owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "conv_draft_snap_conv_snap_idx" ON "conversation_draft_snapshots" USING btree ("conversation_id","snapshot_at");--> statement-breakpoint
CREATE INDEX "conversation_drafts_conv_ordinal_idx" ON "conversation_drafts" USING btree ("conversation_id","ordinal");--> statement-breakpoint
CREATE INDEX "discovery_artifacts_run_kind_idx" ON "discovery_artifacts" USING btree ("run_id","kind");--> statement-breakpoint
CREATE INDEX "discovery_artifacts_tenant_status_idx" ON "discovery_artifacts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "discovery_files_run_idx" ON "discovery_files" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "discovery_runs_tenant_status_idx" ON "discovery_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "events_channel_id_idx" ON "events" USING btree ("channel","id");--> statement-breakpoint
CREATE INDEX "events_tenant_created_idx" ON "events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "execution_fixtures_connector_endpoint_idx" ON "execution_fixtures" USING btree ("connector_id","endpoint_key");--> statement-breakpoint
CREATE INDEX "execution_fixtures_kind_idx" ON "execution_fixtures" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "execution_fixtures_execution_idx" ON "execution_fixtures" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "execution_steps_execution_started_idx" ON "execution_steps" USING btree ("execution_id","started_at");--> statement-breakpoint
CREATE INDEX "executions_tenant_workflow_started_idx" ON "executions" USING btree ("tenant_id","workflow_id","started_at");--> statement-breakpoint
CREATE INDEX "executions_tenant_status_idx" ON "executions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "executions_tenant_status_started_idx" ON "executions" USING btree ("tenant_id","status","started_at");--> statement-breakpoint
CREATE INDEX "executions_tenant_request_source_idx" ON "executions" USING btree ("tenant_id","request_source");--> statement-breakpoint
CREATE INDEX "executions_tenant_source_kind_idx" ON "executions" USING btree ("tenant_id","source_kind");--> statement-breakpoint
CREATE INDEX "patch_candidates_tenant_workflow_status_idx" ON "patch_candidates" USING btree ("tenant_id","workflow_id","status");--> statement-breakpoint
CREATE INDEX "patch_candidates_tenant_status_created_idx" ON "patch_candidates" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "patch_candidates_endpoint_idx" ON "patch_candidates" USING btree ("tenant_id","workflow_id","connector_id","endpoint_key","status");--> statement-breakpoint
CREATE INDEX "external_call_metering_tenant_created_idx" ON "external_call_metering" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "external_call_metering_tenant_provider_month_idx" ON "external_call_metering" USING btree ("tenant_id","provider","month_bucket");--> statement-breakpoint
CREATE INDEX "file_links_tenant_resource_idx" ON "file_links" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_links_conv_slug_uq" ON "file_links" USING btree ("tenant_id","resource_type","resource_id","slug");--> statement-breakpoint
CREATE INDEX "files_tenant_status_idx" ON "files" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "files_tenant_sha256_uq" ON "files" USING btree ("tenant_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_revoked_idx" ON "api_keys" USING btree ("tenant_id","revoked_at");--> statement-breakpoint
CREATE INDEX "api_keys_rotating_out_at_idx" ON "api_keys" USING btree ("rotating_out_at");--> statement-breakpoint
CREATE INDEX "auth_provider_configs_tenant_priority_idx" ON "auth_provider_configs" USING btree ("tenant_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_login_states_state_key" ON "oidc_login_states" USING btree ("state");--> statement-breakpoint
CREATE INDEX "oidc_login_states_expires_idx" ON "oidc_login_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_tokens_prefix_key" ON "portal_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "portal_tokens_tenant_enduser_idx" ON "portal_tokens" USING btree ("tenant_id","enduser_ref");--> statement-breakpoint
CREATE INDEX "sessions_user_expires_idx" ON "sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "sessions_absolute_expires_idx" ON "sessions" USING btree ("absolute_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_last_seen_idx" ON "sessions" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "sessions_token_sha256_idx" ON "sessions" USING btree ("token_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "system_accounts_tenant_name_key" ON "system_accounts" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_key" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_oidc_key" ON "users" USING btree ("tenant_id","oidc_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_external_subject_key" ON "users" USING btree ("tenant_id","external_subject");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tenant_source_ordinal_idx" ON "knowledge_chunks" USING btree ("tenant_id","knowledge_source_id","ordinal");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tsv_idx" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_tenant_slug_key" ON "knowledge_sources" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "knowledge_sources_tenant_idx" ON "knowledge_sources" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_tenant_scope_idx" ON "knowledge_sources" USING btree ("tenant_id","scope");--> statement-breakpoint
CREATE INDEX "knowledge_sources_tenant_workflow_idx" ON "knowledge_sources" USING btree ("tenant_id","workflow_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_tenant_tags_idx" ON "knowledge_sources" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "llm_usage_tenant_created_idx" ON "llm_usage" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_tenant_month_idx" ON "llm_usage" USING btree ("tenant_id","month_bucket");--> statement-breakpoint
CREATE INDEX "tenant_dlp_rules_tenant_enabled_idx" ON "tenant_dlp_rules" USING btree ("tenant_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_llm_settings_tenant_key" ON "tenant_llm_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_recipe_overrides_tenant_client_uq" ON "vendor_recipe_overrides" USING btree ("tenant_id","client");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_access_tokens_sha256_key" ON "mcp_oauth_access_tokens" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "mcp_oauth_access_tokens_prefix_idx" ON "mcp_oauth_access_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "mcp_oauth_access_tokens_tenant_idx" ON "mcp_oauth_access_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_authorization_codes_sha256_key" ON "mcp_oauth_authorization_codes" USING btree ("code_sha256");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorization_codes_expires_idx" ON "mcp_oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_clients_client_id_key" ON "mcp_oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_refresh_tokens_sha256_key" ON "mcp_oauth_refresh_tokens" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_tokens_prefix_idx" ON "mcp_oauth_refresh_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_tokens_tenant_idx" ON "mcp_oauth_refresh_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_states_state_key" ON "mcp_oauth_states" USING btree ("state");--> statement-breakpoint
CREATE INDEX "mcp_oauth_states_tenant_server_idx" ON "mcp_oauth_states" USING btree ("tenant_id","mcp_server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_tenant_namespace_uq" ON "mcp_servers" USING btree ("tenant_id","namespace");--> statement-breakpoint
CREATE INDEX "mcp_servers_tenant_status_idx" ON "mcp_servers" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "mcp_tasks_conv_turn_idx" ON "mcp_tasks" USING btree ("tenant_id","conversation_id","turn_seq");--> statement-breakpoint
CREATE INDEX "mcp_tasks_tenant_created_idx" ON "mcp_tasks" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "cli_notification_inbox_tenant_cursor_idx" ON "cli_notification_inbox" USING btree ("tenant_id","id");--> statement-breakpoint
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
CREATE INDEX "request_hooks_tenant_role_version_idx" ON "request_hooks" USING btree ("tenant_id","role","version");--> statement-breakpoint
CREATE INDEX "self_healing_scans_tenant_created_idx" ON "self_healing_scans" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "self_healing_scans_idem_key" ON "self_healing_scans" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "skill_candidate_evidence_candidate_idx" ON "skill_candidate_evidence" USING btree ("skill_candidate_id");--> statement-breakpoint
CREATE INDEX "skill_candidates_tenant_status_idx" ON "skill_candidates" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "skill_candidates_tenant_connector_idx" ON "skill_candidates" USING btree ("tenant_id","connector_id");--> statement-breakpoint
CREATE INDEX "skill_candidates_tenant_workflow_idx" ON "skill_candidates" USING btree ("tenant_id","workflow_id");--> statement-breakpoint
CREATE INDEX "skill_candidates_tenant_fingerprint_idx" ON "skill_candidates" USING btree ("tenant_id","fingerprint");--> statement-breakpoint
CREATE INDEX "skill_effectiveness_tenant_skill_idx" ON "skill_effectiveness" USING btree ("tenant_id","skill_id");--> statement-breakpoint
CREATE INDEX "skills_tenant_scope_connector_idx" ON "skills" USING btree ("tenant_id","scope","connector_id");--> statement-breakpoint
CREATE INDEX "skills_tenant_scope_workflow_idx" ON "skills" USING btree ("tenant_id","scope","workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_tenant_slug_uq" ON "skills" USING btree ("tenant_id","slug") WHERE "skills"."slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tenant_skill_overrides_pk_idx" ON "tenant_skill_overrides" USING btree ("tenant_id","skill_slug");--> statement-breakpoint
CREATE INDEX "deliveries_tenant_sub_created_idx" ON "deliveries" USING btree ("tenant_id","subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "deliveries_status_retry_idx" ON "deliveries" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "deliveries_tenant_status_created_idx" ON "deliveries" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_active_idx" ON "subscriptions" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_replay_seen_key" ON "webhook_replay_seen" USING btree ("tenant_id","webhook_id","standard_webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_replay_seen_seen_at_idx" ON "webhook_replay_seen" USING btree ("seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_inbound_tenant_slug_key" ON "webhooks_inbound" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "webhooks_outbound_tenant_sub_idx" ON "webhooks_outbound" USING btree ("tenant_id","subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_state_tenant_workflow_key_uniq" ON "workflow_run_state" USING btree ("tenant_id","workflow_id","key");--> statement-breakpoint
CREATE INDEX "workflow_run_state_tenant_workflow_idx" ON "workflow_run_state" USING btree ("tenant_id","workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_signals_match_idx" ON "workflow_signals" USING btree ("tenant_id","execution_id","event_name");--> statement-breakpoint
CREATE INDEX "workflow_signals_received_at_idx" ON "workflow_signals" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_waits_tenant_execution_step_uniq" ON "workflow_waits" USING btree ("tenant_id","execution_id","step_id");--> statement-breakpoint
CREATE INDEX "workflow_waits_sleep_until_idx" ON "workflow_waits" USING btree ("sleep_until_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_autoheal_policies_workflow_key" ON "workflow_autoheal_policies" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_autoheal_policies_tenant_idx" ON "workflow_autoheal_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_workflow_version_key" ON "workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "workflow_versions_tenant_workflow_idx" ON "workflow_versions" USING btree ("tenant_id","workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_tenant_slug_active_key" ON "workflows" USING btree ("tenant_id","slug") WHERE "workflows"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "workflows_tool_catalog_lru_idx" ON "workflows" USING btree ("tenant_id","last_executed_at" DESC NULLS LAST,"created_at") WHERE "workflows"."is_tool" = TRUE AND "workflows"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "workflows_schedules_tenant_workflow_idx" ON "workflows_schedules" USING btree ("tenant_id","workflow_id");