-- SubKit owns a fixed set of unprefixed legacy objects. Naming every object
-- here prevents this migration from ever adopting another product's tables.
CREATE SCHEMA IF NOT EXISTS "subkit";

--> statement-breakpoint
DO $migration$
DECLARE
  object_name text;
BEGIN
  FOREACH object_name IN ARRAY ARRAY[
    'audit_log',
    'risk_signal_edges',
    'chat_deliveries',
    'chat_events_seen',
    'chat_identities',
    'chat_sessions',
    'chat_workspaces',
    'connector_document_chunks',
    'connector_documents',
    'connector_mcp_sessions',
    'connector_template_credentials',
    'connector_templates',
    'connector_endpoint_schemas',
    'connector_credential_setup_grants',
    'connector_environments',
    'connector_oauth_start_grants',
    'connector_oauth_states',
    'connector_promotions',
    'connectors',
    'credentials',
    'end_user_credentials',
    'schema_versions',
    'conversation_elicitations',
    'conversation_messages',
    'conversation_tool_calls',
    'conversations',
    'conversation_draft_snapshots',
    'conversation_drafts',
    'data_migrations',
    'discovery_artifacts',
    'discovery_files',
    'discovery_runs',
    'events',
    'outbox_cursors',
    'execution_fixtures',
    'execution_steps',
    'executions',
    'patch_candidates',
    'external_call_metering',
    'file_links',
    'files',
    'files_dedup_seen',
    'api_keys',
    'auth_provider_configs',
    'engine_settings',
    'oidc_login_states',
    'portal_tokens',
    'sessions',
    'system_accounts',
    'tenants',
    'user_identities',
    'user_invites',
    'users',
    'knowledge_chunks',
    'knowledge_sources',
    'llm_usage',
    'tenant_dlp_rules',
    'tenant_llm_settings',
    'user_llm_settings',
    'vendor_recipe_overrides',
    'mcp_oauth_access_tokens',
    'mcp_oauth_authorization_codes',
    'mcp_oauth_clients',
    'mcp_oauth_refresh_tokens',
    'mcp_oauth_states',
    'mcp_tasks',
    'cli_notification_inbox',
    'cli_notification_inbox_reads',
    'notification_channels',
    'notification_deliveries',
    'notification_rules',
    'group_members',
    'group_role_assignments',
    'groups',
    'permissions',
    'resource_grants',
    'role_permissions',
    'roles',
    'request_hooks',
    'self_healing_scans',
    'skill_candidate_evidence',
    'skill_candidates',
    'skill_effectiveness',
    'skills',
    'tenant_skill_overrides',
    'tool_approvals',
    'usage_events',
    'deliveries',
    'subscriptions',
    'webhook_replay_seen',
    'webhooks_inbound',
    'webhooks_outbound',
    'workflow_run_state',
    'workflow_signals',
    'workflow_waits',
    'workflow_autoheal_policies',
    'workflow_versions',
    'workflows',
    'workflows_schedules'
  ]
  LOOP
    IF to_regclass(format('public.%I', object_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA subkit', object_name);
    END IF;
  END LOOP;
END
$migration$;
--> statement-breakpoint
DO $migration$
DECLARE
  type_name text;
BEGIN
  FOREACH type_name IN ARRAY ARRAY[
    'execution_mode',
    'chat_platform',
    'doc_source_type',
    'connector_template_source',
    'credential_mode',
    'end_user_combine_mode',
    'environment',
    'elicitation_status',
    'conversation_role',
    'conversation_status',
    'discovery_artifact_kind',
    'discovery_artifact_status',
    'discovery_run_status',
    'execution_status',
    'patch_classification',
    'patch_status',
    'file_link_resource',
    'file_status',
    'audit_actor_kind',
    'egress_guard_mode',
    'user_role',
    'user_status',
    'knowledge_source_refresh',
    'knowledge_source_scope',
    'knowledge_source_status',
    'skill_candidate_confidence',
    'skill_candidate_pattern',
    'skill_candidate_status',
    'skill_lifecycle',
    'skill_scope',
    'skill_source',
    'autoheal_policy',
    'workflow_lifecycle'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typname = type_name AND t.typtype = 'e'
    ) THEN
      EXECUTE format('ALTER TYPE public.%I SET SCHEMA subkit', type_name);
    END IF;
  END LOOP;
END
$migration$;

--> statement-breakpoint
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'pgboss')
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'subkit_queue') THEN
    RAISE EXCEPTION 'both legacy and isolated queue schemas exist; refusing to merge queue state';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'pgboss') THEN
    ALTER SCHEMA pgboss RENAME TO subkit_queue;
  END IF;
END
$migration$;

--> statement-breakpoint
DROP TABLE IF EXISTS "drizzle"."__drizzle_migrations";

--> statement-breakpoint
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'drizzle')
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'drizzle'
     ) THEN
    DROP SCHEMA drizzle;
  END IF;
END
$migration$;
