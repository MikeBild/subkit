SET LOCAL check_function_bodies = false;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "public";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS subkit;
--> statement-breakpoint
CREATE TYPE public.scheduler_sweep_producer AS ENUM (
    'catalog',
    'docs',
    'workflow-cron',
    'drift',
    'reauth',
    'endpoint-contract',
    'knowledge',
    'skill',
    'task'
);
--> statement-breakpoint
CREATE TYPE public.tenant_branding_palette AS ENUM (
    'standard',
    'indigo',
    'teal'
);
--> statement-breakpoint
CREATE TYPE public.tenant_origin AS ENUM (
    'self_hosted',
    'self_service'
);
--> statement-breakpoint
CREATE TYPE public.tenant_status AS ENUM (
    'active',
    'suspended',
    'pending_deletion'
);
--> statement-breakpoint
CREATE TYPE subkit.audit_actor_kind AS ENUM (
    'user',
    'system_account',
    'system',
    'unknown'
);
--> statement-breakpoint
CREATE TYPE subkit.autoheal_policy AS ENUM (
    'safe-patches',
    'never-auto',
    'dry-run-gate'
);
--> statement-breakpoint
CREATE TYPE subkit.chat_platform AS ENUM (
    'slack',
    'teams',
    'google_chat'
);
--> statement-breakpoint
CREATE TYPE subkit.connector_template_source AS ENUM (
    'builtin',
    'tenant'
);
--> statement-breakpoint
CREATE TYPE subkit.conversation_role AS ENUM (
    'user',
    'assistant',
    'tool',
    'system'
);
--> statement-breakpoint
CREATE TYPE subkit.conversation_status AS ENUM (
    'active',
    'awaiting_input',
    'committed',
    'abandoned'
);
--> statement-breakpoint
CREATE TYPE subkit.credential_mode AS ENUM (
    'none',
    'header',
    'query',
    'bearer',
    'basic',
    'oauth2',
    'aws_sigv4',
    'token_mint',
    'oauth2_client',
    'oauth2_private_key',
    'signed_jwt'
);
--> statement-breakpoint
CREATE TYPE subkit.discovery_artifact_kind AS ENUM (
    'connector',
    'skill',
    'knowledge_source',
    'capability_gap'
);
--> statement-breakpoint
CREATE TYPE subkit.discovery_artifact_status AS ENUM (
    'proposed',
    'approved',
    'rejected',
    'superseded'
);
--> statement-breakpoint
CREATE TYPE subkit.discovery_run_status AS ENUM (
    'pending',
    'analyzing',
    'synthesizing',
    'completed',
    'failed'
);
--> statement-breakpoint
CREATE TYPE subkit.doc_source_type AS ENUM (
    'openapi',
    'google_discovery',
    'markdown',
    'llms_txt',
    'html',
    'graphql',
    'postgres',
    'file_upload'
);
--> statement-breakpoint
CREATE TYPE subkit.egress_guard_mode AS ENUM (
    'strict',
    'permissive'
);
--> statement-breakpoint
CREATE TYPE subkit.elicitation_status AS ENUM (
    'pending',
    'resolved',
    'cancelled',
    'timeout'
);
--> statement-breakpoint
CREATE TYPE subkit.environment AS ENUM (
    'dev',
    'prod'
);
--> statement-breakpoint
CREATE TYPE subkit.execution_mode AS ENUM (
    'dev',
    'prod'
);
--> statement-breakpoint
CREATE TYPE subkit.execution_status AS ENUM (
    'queued',
    'waiting_for_device',
    'running',
    'succeeded',
    'failed',
    'aborted',
    'timed_out'
);
--> statement-breakpoint
CREATE TYPE subkit.file_link_resource AS ENUM (
    'conversation',
    'knowledge_source',
    'skill',
    'connector',
    'workflow_run',
    'discovery_run'
);
--> statement-breakpoint
CREATE TYPE subkit.file_status AS ENUM (
    'pending',
    'uploading',
    'scanning',
    'ready',
    'failed',
    'expired'
);
--> statement-breakpoint
CREATE TYPE subkit.intake_item_state AS ENUM (
    'collected',
    'reviewing',
    'admitted',
    'discarded'
);
--> statement-breakpoint
CREATE TYPE subkit.intake_proposal_status AS ENUM (
    'draft',
    'stale',
    'confirmed',
    'rejected'
);
--> statement-breakpoint
CREATE TYPE subkit.knowledge_source_refresh AS ENUM (
    'manual',
    'scheduled',
    'webhook'
);
--> statement-breakpoint
CREATE TYPE subkit.knowledge_source_scope AS ENUM (
    'global',
    'workflow'
);
--> statement-breakpoint
CREATE TYPE subkit.knowledge_source_status AS ENUM (
    'active',
    'inactive',
    'processing',
    'error'
);
--> statement-breakpoint
CREATE TYPE subkit.patch_classification AS ENUM (
    'safe',
    'unsafe'
);
--> statement-breakpoint
CREATE TYPE subkit.patch_status AS ENUM (
    'proposed',
    'applied',
    'rejected',
    'superseded',
    'inapplicable'
);
--> statement-breakpoint
CREATE TYPE subkit.runtime_config_replica_ack_status AS ENUM (
    'idle',
    'preparing',
    'ack',
    'nack'
);
--> statement-breakpoint
CREATE TYPE subkit.runtime_config_revision_status AS ENUM (
    'saved',
    'preparing',
    'active',
    'failed',
    'restart_required'
);
--> statement-breakpoint
CREATE TYPE subkit.skill_candidate_confidence AS ENUM (
    'low',
    'medium',
    'high'
);
--> statement-breakpoint
CREATE TYPE subkit.skill_candidate_pattern AS ENUM (
    'repair_pattern',
    'failure_pattern',
    'success_pattern',
    'chained_workflow_pattern',
    'authoring_capability',
    'session_learning',
    'connector_capability',
    'knowledge_learning'
);
--> statement-breakpoint
CREATE TYPE subkit.skill_candidate_status AS ENUM (
    'proposed',
    'approved',
    'rejected',
    'superseded',
    'context'
);
--> statement-breakpoint
CREATE TYPE subkit.skill_lifecycle AS ENUM (
    'draft',
    'active',
    'archived'
);
--> statement-breakpoint
CREATE TYPE subkit.skill_scope AS ENUM (
    'global',
    'connector',
    'workflow'
);
--> statement-breakpoint
CREATE TYPE subkit.skill_source AS ENUM (
    'manual',
    'candidate',
    'template',
    'memory'
);
--> statement-breakpoint
CREATE TYPE subkit.user_status AS ENUM (
    'invited',
    'active',
    'disabled'
);
--> statement-breakpoint
CREATE TYPE subkit.vault_cipher_replacement AS (
	name text,
	version integer,
	expected_ciphertext bytea,
	expected_iv bytea,
	expected_auth_tag bytea,
	replacement_ciphertext bytea,
	replacement_iv bytea,
	replacement_auth_tag bytea,
	unchanged boolean
);
--> statement-breakpoint
CREATE TYPE subkit.vault_cipher_snapshot AS (
	name text,
	version integer,
	tenant_id uuid,
	ciphertext bytea,
	iv bytea,
	auth_tag bytea,
	metadata_sha256 text
);
--> statement-breakpoint
CREATE TYPE subkit.vault_snapshot_page AS (
	operation_id uuid,
	page_number integer,
	source_epoch bigint,
	page_sha256 text,
	has_more boolean,
	rows subkit.vault_cipher_snapshot[]
);
--> statement-breakpoint
CREATE TYPE subkit.workflow_lifecycle AS ENUM (
    'draft',
    'active',
    'archived'
);
--> statement-breakpoint
CREATE FUNCTION subkit.api_key_credential_origin_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.credential_origin IS DISTINCT FROM NEW.credential_origin THEN
    RAISE EXCEPTION 'api_key_credential_origin_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.catalog_category_assignment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  current_name text;
  next_name text;
  visited text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id AND NEW.category IS NOT DISTINCT FROM OLD.category THEN
    RETURN NEW;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 741937)) THEN
    RAISE EXCEPTION 'Catalog vocabulary changed concurrently; retry the operation' USING ERRCODE = '40001';
  END IF;
  current_name := NEW.category;
  LOOP
    IF current_name = ANY(visited) OR cardinality(visited) >= 64 THEN
      RAISE EXCEPTION 'Catalog category redirect cycle' USING ERRCODE = '23514';
    END IF;
    visited := array_append(visited, current_name);
    SELECT redirect_to INTO next_name FROM catalog_categories
      WHERE tenant_id = NEW.tenant_id AND name = current_name;
    EXIT WHEN next_name IS NULL;
    current_name := next_name;
  END LOOP;
  IF current_name NOT IN ('other', 'platform') THEN
    INSERT INTO catalog_categories (tenant_id, name, purpose_pending)
      VALUES (NEW.tenant_id, current_name, true) ON CONFLICT DO NOTHING;
  END IF;
  NEW.category := current_name;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.guard_approval_execution_link() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'subkit'
    AS $$
BEGIN
  IF OLD.claimed_execution_id IS NOT NULL AND
     NEW.claimed_execution_id IS DISTINCT FROM OLD.claimed_execution_id THEN
    RAISE EXCEPTION 'approval execution link is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.guard_authorized_workflow_version() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'subkit'
    AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.version, NEW.dag, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.version, OLD.dag, OLD.created_at)
     AND EXISTS (
       SELECT 1 FROM "subkit"."workflow_execution_authorities" authority
        WHERE authority.tenant_id = OLD.tenant_id
          AND authority.workflow_id = OLD.workflow_id
          AND authority.workflow_version_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'authorized workflow version is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.guard_execution_authority_binding() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'subkit'
    AS $$
BEGIN
  IF NEW.execution_authority_id IS DISTINCT FROM OLD.execution_authority_id THEN
    RAISE EXCEPTION 'execution authority cannot be attached, removed or replaced after admission' USING ERRCODE = '23514';
  END IF;
  IF OLD.execution_authority_id IS NOT NULL AND
     ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id, NEW.execution_mode,
         NEW.source_kind, NEW.source_ref, NEW.input, NEW.idempotency_key, NEW.parent_execution_id,
         NEW.request_source, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id, OLD.execution_mode,
         OLD.source_kind, OLD.source_ref, OLD.input, OLD.idempotency_key, OLD.parent_execution_id,
         OLD.request_source, OLD.created_at) THEN
    RAISE EXCEPTION 'authorized execution boundary is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.guard_execution_authority_link() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'subkit'
    AS $$
BEGIN
  -- A run may not acquire, drop or move its link to a root's approval. Without
  -- this, an unapproved run could be pointed at an approved one after the fact
  -- and borrow its permission on the next dispatch.
  IF NEW.authority_root_execution_id IS DISTINCT FROM OLD.authority_root_execution_id
     OR NEW.authority_call_path IS DISTINCT FROM OLD.authority_call_path THEN
    RAISE EXCEPTION 'authority link cannot be attached, removed or replaced after the run is created' USING ERRCODE = '23514';
  END IF;
  -- What the root's approval was measured against must stay put for a linked
  -- run, exactly as it does for one holding its own approval.
  IF OLD.authority_root_execution_id IS NOT NULL AND
     ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id, NEW.execution_mode,
         NEW.source_kind, NEW.source_ref, NEW.input, NEW.idempotency_key, NEW.parent_execution_id,
         NEW.request_source, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id, OLD.execution_mode,
         OLD.source_kind, OLD.source_ref, OLD.input, OLD.idempotency_key, OLD.parent_execution_id,
         OLD.request_source, OLD.created_at) THEN
    RAISE EXCEPTION 'linked execution boundary is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.guard_intake_item_evidence_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'subkit'
    AS $$
BEGIN
  RAISE EXCEPTION 'intake item evidence is append-only' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.guard_preparation_execution() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'subkit'
    AS $$
BEGIN
  IF NEW.hold_writes AND NEW.execution_authority_id IS NOT NULL THEN
    RAISE EXCEPTION 'a preparation run cannot consume a live authority' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.hold_writes IS DISTINCT FROM OLD.hold_writes THEN
      RAISE EXCEPTION 'execution preparation mode is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.hold_writes AND
       ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id, NEW.execution_mode,
           NEW.source_kind, NEW.source_ref, NEW.input, NEW.idempotency_key, NEW.parent_execution_id,
           NEW.request_source, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id, OLD.execution_mode,
           OLD.source_kind, OLD.source_ref, OLD.input, OLD.idempotency_key, OLD.parent_execution_id,
           OLD.request_source, OLD.created_at) THEN
      RAISE EXCEPTION 'preparation execution boundary is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.guard_tool_approval_execution() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'subkit'
    AS $_$
DECLARE item record;
BEGIN
  IF jsonb_typeof(NEW.tool_approval_dispatches) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'single-use dispatch counters must be an object' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.tool_approval_dispatches <> '{}'::jsonb THEN
      RAISE EXCEPTION 'new executions cannot contain dispatch reservations' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tool_approval_id IS NULL AND NEW.tool_approval_dispatches <> '{}'::jsonb THEN
    RAISE EXCEPTION 'dispatch reservations require an approval' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT key, value FROM jsonb_each(NEW.tool_approval_dispatches) LOOP
    IF jsonb_typeof(item.value) IS DISTINCT FROM 'object' OR
       jsonb_typeof(item.value->'step_key') IS DISTINCT FROM 'string' OR
       length(item.value->>'step_key') = 0 OR
       jsonb_typeof(item.value->'digest') IS DISTINCT FROM 'string' OR
       (item.value->>'digest') !~ '^[a-f0-9]{64}$' OR
       jsonb_typeof(item.value->'attempts') IS DISTINCT FROM 'number' OR
       (item.value->>'attempts') !~ '^([1-9]|1[0-9]|20)$' THEN
      RAISE EXCEPTION 'invalid single-use dispatch reservation' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NEW.tool_approval_id IS DISTINCT FROM OLD.tool_approval_id THEN
    RAISE EXCEPTION 'execution tool approval is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.tool_approval_id IS NOT NULL THEN
    IF ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id, NEW.execution_mode,
           NEW.source_kind, NEW.source_ref, NEW.input, NEW.idempotency_key, NEW.parent_execution_id,
           NEW.request_source, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id, OLD.execution_mode,
           OLD.source_kind, OLD.source_ref, OLD.input, OLD.idempotency_key, OLD.parent_execution_id,
           OLD.request_source, OLD.created_at) THEN
      RAISE EXCEPTION 'single-use execution boundary is immutable' USING ERRCODE = '23514';
    END IF;
    FOR item IN SELECT key, value FROM jsonb_each(OLD.tool_approval_dispatches) LOOP
      IF NOT (NEW.tool_approval_dispatches ? item.key) OR
        NEW.tool_approval_dispatches->item.key->>'digest' IS DISTINCT FROM item.value->>'digest' OR
        NEW.tool_approval_dispatches->item.key->>'step_key' IS DISTINCT FROM item.value->>'step_key' OR
        (NEW.tool_approval_dispatches->item.key->>'attempts')::integer < (item.value->>'attempts')::integer THEN
        RAISE EXCEPTION 'single-use dispatch counters cannot decrease' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$_$;
--> statement-breakpoint
CREATE FUNCTION subkit.guard_workflow_execution_authority() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'subkit'
    AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id,
         NEW.effect_manifest_digest, NEW.effect_manifest, NEW.execution_environment,
         NEW.target_constraints, NEW.valid_from, NEW.valid_until, NEW.max_runs,
         NEW.created_by, NEW.created_at, NEW.inherited_from, NEW.approved_manifest)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id,
         OLD.effect_manifest_digest, OLD.effect_manifest, OLD.execution_environment,
         OLD.target_constraints, OLD.valid_from, OLD.valid_until, OLD.max_runs,
         OLD.created_by, OLD.created_at, OLD.inherited_from, OLD.approved_manifest) THEN
    RAISE EXCEPTION 'workflow execution authority boundary is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.reserved_runs < OLD.reserved_runs THEN
    RAISE EXCEPTION 'workflow execution reservations cannot be reset' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND
     ROW(NEW.revoked_at, NEW.revoked_by, NEW.reserved_runs, NEW.superseded_by)
       IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revoked_by, OLD.reserved_runs, OLD.superseded_by) THEN
    RAISE EXCEPTION 'revoked workflow execution authority is terminal' USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'a continued workflow execution authority must end' USING ERRCODE = '23514';
  END IF;
  IF NEW.reserved_runs > OLD.reserved_runs AND
     (NEW.revoked_at IS NOT NULL OR clock_timestamp() < NEW.valid_from OR
      (NEW.valid_until IS NOT NULL AND clock_timestamp() >= NEW.valid_until)) THEN
    RAISE EXCEPTION 'workflow execution authority is outside its live window' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_apply_usage(p_tenant uuid, p_resource text, p_bytes bigint, p_count bigint) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE v_origin text; v_document jsonb; v_limit bigint; v_rows bigint; v_usage bigint; v_count bigint;
BEGIN
 SELECT origin::text INTO v_origin FROM subkit.tenants WHERE id=p_tenant;
 IF v_origin IS DISTINCT FROM 'self_service' THEN RETURN; END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='hosted_quota_requires_read_committed'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(p_tenant::text,741937)) THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='hosted_quota_concurrent_write'; END IF;
 SELECT logical_bytes,COALESCE((resource_counts->>p_resource)::bigint,0) INTO v_usage,v_count FROM subkit.hosted_tenant_usage WHERE tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_storage_quota_exhausted'; END IF;
 IF p_bytes>0 OR p_count>0 THEN
  PERFORM 1 FROM subkit.runtime_config_state WHERE key='runtime' FOR SHARE;
  SELECT r.document INTO v_document FROM subkit.runtime_config_state s JOIN subkit.runtime_config_revisions r ON r.revision=s.active_revision WHERE s.key='runtime';
  IF COALESCE(v_document#>>'{storage,hosted,tenant_bytes}','') !~ '^[1-9][0-9]{0,17}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_storage_quota_exhausted'; END IF;
  v_limit:=(v_document#>>'{storage,hosted,tenant_bytes}')::bigint;
  IF p_bytes>0 AND v_usage+p_bytes>v_limit THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_storage_quota_exhausted'; END IF;
  IF p_count>0 THEN
   IF COALESCE(v_document#>>'{storage,hosted,retained_rows_per_resource}','') !~ '^[1-9][0-9]{0,6}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_resource_count_exhausted'; END IF;
   v_rows:=(v_document#>>'{storage,hosted,retained_rows_per_resource}')::bigint;
   IF v_count+p_count>v_rows THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_resource_count_exhausted'; END IF;
  END IF;
 END IF;
 IF v_usage+p_bytes<0 OR v_count+p_count<0 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_usage_inconsistent'; END IF;
 UPDATE subkit.hosted_tenant_usage SET logical_bytes=logical_bytes+p_bytes,resource_counts=jsonb_set(resource_counts,ARRAY[p_resource],to_jsonb((v_count+p_count)::text)),updated_at=clock_timestamp() WHERE tenant_id=p_tenant;
END $_$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_audit_metadata_without_provenance(p_metadata jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
BEGIN
 IF p_metadata IS NULL OR jsonb_typeof(p_metadata)<>'object' THEN RETURN NULL; END IF;
 IF (p_metadata ? 'request_source' AND (jsonb_typeof(p_metadata->'request_source')<>'string' OR NOT COALESCE(p_metadata->>'request_source' IN ('api','cli','scheduler','mcp','webhook','tool-chain','ui','chat','queue'),false)))
 OR (p_metadata ? 'origin_source' AND (jsonb_typeof(p_metadata->'origin_source')<>'string' OR NOT COALESCE(p_metadata->>'origin_source' IN ('api','cli','scheduler','mcp','webhook','tool-chain','ui','chat','queue'),false)))
 OR (p_metadata ? 'execution_source' AND (jsonb_typeof(p_metadata->'execution_source')<>'string' OR NOT COALESCE(p_metadata->>'execution_source' IN ('api','cli','scheduler','mcp','webhook','tool-chain','ui','chat','queue'),false)))
 OR (p_metadata ? 'audit_trace_id' AND (jsonb_typeof(p_metadata->'audit_trace_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_trace_id' ~ '^[0-9a-f]{32}$',false)))
 OR (p_metadata ? 'api_key_id' AND (jsonb_typeof(p_metadata->'api_key_id')<>'string' OR NOT COALESCE(p_metadata->>'api_key_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'session_id' AND (jsonb_typeof(p_metadata->'session_id')<>'string' OR NOT COALESCE(p_metadata->>'session_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'audit_used_api_key_id' AND (jsonb_typeof(p_metadata->'audit_used_api_key_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_used_api_key_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'audit_used_session_id' AND (jsonb_typeof(p_metadata->'audit_used_session_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_used_session_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'audit_access_type' AND (jsonb_typeof(p_metadata->'audit_access_type')<>'string' OR NOT COALESCE(p_metadata->>'audit_access_type' IN ('api_key','browser_session','mcp_oauth','token_exchange','external_bearer','portal_token','task_run'),false)))
 OR (p_metadata ? 'audit_credential_origin' AND (jsonb_typeof(p_metadata->'audit_credential_origin')<>'string' OR NOT COALESCE(p_metadata->>'audit_credential_origin'='cli_oauth_session',false)))
 OR (p_metadata ? 'audit_oauth_client_id' AND (jsonb_typeof(p_metadata->'audit_oauth_client_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_oauth_client_id' ~ '^[A-Za-z0-9._:-]{1,128}$',false))) THEN RETURN NULL; END IF;
 RETURN p_metadata-ARRAY['request_source','origin_source','execution_source','audit_trace_id','api_key_id','session_id','audit_used_api_key_id','audit_used_session_id','audit_access_type','audit_credential_origin','audit_oauth_client_id'];
END $_$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_cascade_group_members() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_bytes bigint; v_count bigint;
BEGIN
 SELECT COALESCE(sum(0::bigint),0)::bigint,count(*) INTO v_bytes,v_count FROM subkit."group_members" r WHERE r."group_id"=OLD.id;
 IF v_count>0 THEN PERFORM subkit.hosted_apply_usage(OLD.tenant_id,'group_members',-v_bytes,-v_count); END IF;
 RETURN OLD;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_cascade_group_role_assignments() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_bytes bigint; v_count bigint;
BEGIN
 SELECT COALESCE(sum(0::bigint),0)::bigint,count(*) INTO v_bytes,v_count FROM subkit."group_role_assignments" r WHERE r."group_id"=OLD.id;
 IF v_count>0 THEN PERFORM subkit.hosted_apply_usage(OLD.tenant_id,'group_role_assignments',-v_bytes,-v_count); END IF;
 RETURN OLD;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_cascade_role_permissions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_bytes bigint; v_count bigint;
BEGIN
 SELECT COALESCE(sum(0::bigint),0)::bigint,count(*) INTO v_bytes,v_count FROM subkit."role_permissions" r WHERE r."role_id"=OLD.id;
 IF v_count>0 THEN PERFORM subkit.hosted_apply_usage(OLD.tenant_id,'role_permissions',-v_bytes,-v_count); END IF;
 RETURN OLD;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_cascade_skill_candidate_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_bytes bigint; v_count bigint;
BEGIN
 SELECT COALESCE(sum(COALESCE(octet_length(convert_to(r."evidence_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."summary"::text,'UTF8')),0)::bigint),0)::bigint,count(*) INTO v_bytes,v_count FROM subkit."skill_candidate_evidence" r WHERE r."skill_candidate_id"=OLD.id;
 IF v_count>0 THEN PERFORM subkit.hosted_apply_usage(OLD.tenant_id,'skill_candidate_evidence',-v_bytes,-v_count); END IF;
 RETURN OLD;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_content_quota_terminal(p_table text, j jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
 SELECT COALESCE(CASE WHEN p_table='executions' THEN
  j->>'status'='failed' AND j->>'finished_at' IS NOT NULL AND j#>>'{failure,error_code}' IN ('hosted_storage_quota_exhausted','hosted_resource_count_exhausted')
  AND j->'failure'=jsonb_build_object('step_id',NULL,'error_code',j#>>'{failure,error_code}','error_message','Workspace resource allowance exhausted.')
 WHEN p_table='mcp_tasks' THEN
  j->>'failure_reason' IN ('hosted_storage_quota_exhausted','hosted_resource_count_exhausted') AND j->>'result' IS NULL AND j->>'cancelled_at' IS NULL
 ELSE false END,false)
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_control_receipt_id(p_tenant uuid, p_type text, p_resource uuid) RETURNS uuid
    LANGUAGE sql IMMUTABLE
    AS $$
 SELECT overlay(overlay(substr(encode(public.digest('hosted-resource-control:'||p_tenant::text||':'||p_type||':'||p_resource::text,'sha256'),'hex'),1,32) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_initialize_usage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 IF NEW.origin='self_service' THEN INSERT INTO subkit.hosted_tenant_usage(tenant_id) VALUES(NEW.id); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_api_keys() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."prefix"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."allowed_workflows"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."allowed_connectors"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."prefix"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."allowed_workflows"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."allowed_connectors"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'api_keys',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_audit_log() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(CASE WHEN COALESCE((subkit.hosted_singleton_control_receipt(to_jsonb(OLD)) OR (
 OLD.actor_type IN ('system','user')
 AND OLD.before IS NULL AND OLD.after IS NULL AND OLD.user_agent IS NULL
 AND OLD.resource_id ~ '^[0-9a-f-]{36}$'
 AND COALESCE(length(OLD.ip),0)<=64 AND COALESCE(length(OLD.trace_id),0)<=128
 AND subkit.hosted_audit_metadata_without_provenance(OLD.metadata) IS NOT NULL
 AND (NOT (OLD.metadata ? 'auth_via') OR OLD.metadata->>'auth_via'='token_exchange')
 AND (
 ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'execution_privacy'='sensitive' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' ? 'execution_id') OR (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (OLD.reason IS NULL OR OLD.reason='sensitive_execution') AND ((OLD.resource_type='hosted_work' AND OLD.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (OLD.resource_type='llm_budget' AND OLD.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (OLD.resource_type='hosted_work' AND OLD.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE((CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via','{}'::jsonb)='{}'::jsonb
 AND (OLD.reason IS NULL OR OLD.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (OLD.resource_type='llm_budget' AND OLD.reason IS NULL AND
 ((OLD.action='llm.budget.reserved' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'currency'='USD' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (OLD.action='llm.budget.settled' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'currency'='USD' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'state' IN ('settled','released','reconciliation_required'))))
 OR (OLD.resource_type='tenant' AND OLD.resource_id=OLD.tenant_id::text AND (
 (OLD.action='tenant.deletion_requested' AND OLD.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - 'deletion_scheduled_for'='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (OLD.action='tenant.restored' AND OLD.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'='{"via":"verified_identity_recovery"}'::jsonb)
 OR (OLD.action='tenant.updated' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'source'='tenant_erasure' AND (
 (OLD.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - ARRAY['source','stage','attempt']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' ? 'attempt') OR (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (OLD.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'='{"source":"tenant_erasure"}'::jsonb)))
 OR (OLD.action='tenant.deleted' AND OLD.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (OLD.action='tenant.updated' AND OLD.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'source'='tenant_erasure_runtime_cleanup' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'revisions' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'secret_versions' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'restart_requests' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (OLD.resource_type='hosted_work' AND OLD.action='hosted_work.reconciled' AND OLD.reason='operator_reviewed_owner_stop' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))),false) THEN 0 ELSE COALESCE(octet_length(convert_to(OLD."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."resource_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."resource_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."trace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."ip"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."user_agent"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."before"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."after"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."metadata"::text,'UTF8')),0)::bigint END);v_count:=v_count-(CASE WHEN COALESCE((subkit.hosted_singleton_control_receipt(to_jsonb(OLD)) OR (
 OLD.actor_type IN ('system','user')
 AND OLD.before IS NULL AND OLD.after IS NULL AND OLD.user_agent IS NULL
 AND OLD.resource_id ~ '^[0-9a-f-]{36}$'
 AND COALESCE(length(OLD.ip),0)<=64 AND COALESCE(length(OLD.trace_id),0)<=128
 AND subkit.hosted_audit_metadata_without_provenance(OLD.metadata) IS NOT NULL
 AND (NOT (OLD.metadata ? 'auth_via') OR OLD.metadata->>'auth_via'='token_exchange')
 AND (
 ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'execution_privacy'='sensitive' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' ? 'execution_id') OR (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (OLD.reason IS NULL OR OLD.reason='sensitive_execution') AND ((OLD.resource_type='hosted_work' AND OLD.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (OLD.resource_type='llm_budget' AND OLD.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (OLD.resource_type='hosted_work' AND OLD.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE((CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via','{}'::jsonb)='{}'::jsonb
 AND (OLD.reason IS NULL OR OLD.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (OLD.resource_type='llm_budget' AND OLD.reason IS NULL AND
 ((OLD.action='llm.budget.reserved' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'currency'='USD' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (OLD.action='llm.budget.settled' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'currency'='USD' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'state' IN ('settled','released','reconciliation_required'))))
 OR (OLD.resource_type='tenant' AND OLD.resource_id=OLD.tenant_id::text AND (
 (OLD.action='tenant.deletion_requested' AND OLD.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - 'deletion_scheduled_for'='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (OLD.action='tenant.restored' AND OLD.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'='{"via":"verified_identity_recovery"}'::jsonb)
 OR (OLD.action='tenant.updated' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'source'='tenant_erasure' AND (
 (OLD.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - ARRAY['source','stage','attempt']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' ? 'attempt') OR (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (OLD.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'='{"source":"tenant_erasure"}'::jsonb)))
 OR (OLD.action='tenant.deleted' AND OLD.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (OLD.action='tenant.updated' AND OLD.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'source'='tenant_erasure_runtime_cleanup' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'revisions' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'secret_versions' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'restart_requests' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (OLD.resource_type='hosted_work' AND OLD.action='hosted_work.reconciled' AND OLD.reason='operator_reviewed_owner_stop' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via' - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(OLD.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(OLD.metadata) END)-'auth_via'->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))),false) THEN 0 ELSE 1 END); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(CASE WHEN COALESCE((subkit.hosted_singleton_control_receipt(to_jsonb(NEW)) OR (
 NEW.actor_type IN ('system','user')
 AND NEW.before IS NULL AND NEW.after IS NULL AND NEW.user_agent IS NULL
 AND NEW.resource_id ~ '^[0-9a-f-]{36}$'
 AND COALESCE(length(NEW.ip),0)<=64 AND COALESCE(length(NEW.trace_id),0)<=128
 AND subkit.hosted_audit_metadata_without_provenance(NEW.metadata) IS NOT NULL
 AND (NOT (NEW.metadata ? 'auth_via') OR NEW.metadata->>'auth_via'='token_exchange')
 AND (
 ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'execution_privacy'='sensitive' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' ? 'execution_id') OR (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (NEW.reason IS NULL OR NEW.reason='sensitive_execution') AND ((NEW.resource_type='hosted_work' AND NEW.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (NEW.resource_type='llm_budget' AND NEW.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (NEW.resource_type='hosted_work' AND NEW.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE((CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via','{}'::jsonb)='{}'::jsonb
 AND (NEW.reason IS NULL OR NEW.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (NEW.resource_type='llm_budget' AND NEW.reason IS NULL AND
 ((NEW.action='llm.budget.reserved' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'currency'='USD' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (NEW.action='llm.budget.settled' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'currency'='USD' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'state' IN ('settled','released','reconciliation_required'))))
 OR (NEW.resource_type='tenant' AND NEW.resource_id=NEW.tenant_id::text AND (
 (NEW.action='tenant.deletion_requested' AND NEW.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - 'deletion_scheduled_for'='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (NEW.action='tenant.restored' AND NEW.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'='{"via":"verified_identity_recovery"}'::jsonb)
 OR (NEW.action='tenant.updated' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'source'='tenant_erasure' AND (
 (NEW.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - ARRAY['source','stage','attempt']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' ? 'attempt') OR (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (NEW.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'='{"source":"tenant_erasure"}'::jsonb)))
 OR (NEW.action='tenant.deleted' AND NEW.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (NEW.action='tenant.updated' AND NEW.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'source'='tenant_erasure_runtime_cleanup' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'revisions' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'secret_versions' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'restart_requests' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (NEW.resource_type='hosted_work' AND NEW.action='hosted_work.reconciled' AND NEW.reason='operator_reviewed_owner_stop' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))),false) THEN 0 ELSE COALESCE(octet_length(convert_to(NEW."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."resource_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."resource_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."trace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."ip"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."user_agent"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."before"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."after"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."metadata"::text,'UTF8')),0)::bigint END);v_count:=v_count+(CASE WHEN COALESCE((subkit.hosted_singleton_control_receipt(to_jsonb(NEW)) OR (
 NEW.actor_type IN ('system','user')
 AND NEW.before IS NULL AND NEW.after IS NULL AND NEW.user_agent IS NULL
 AND NEW.resource_id ~ '^[0-9a-f-]{36}$'
 AND COALESCE(length(NEW.ip),0)<=64 AND COALESCE(length(NEW.trace_id),0)<=128
 AND subkit.hosted_audit_metadata_without_provenance(NEW.metadata) IS NOT NULL
 AND (NOT (NEW.metadata ? 'auth_via') OR NEW.metadata->>'auth_via'='token_exchange')
 AND (
 ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'execution_privacy'='sensitive' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' ? 'execution_id') OR (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (NEW.reason IS NULL OR NEW.reason='sensitive_execution') AND ((NEW.resource_type='hosted_work' AND NEW.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (NEW.resource_type='llm_budget' AND NEW.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (NEW.resource_type='hosted_work' AND NEW.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE((CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via','{}'::jsonb)='{}'::jsonb
 AND (NEW.reason IS NULL OR NEW.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (NEW.resource_type='llm_budget' AND NEW.reason IS NULL AND
 ((NEW.action='llm.budget.reserved' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'currency'='USD' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (NEW.action='llm.budget.settled' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'currency'='USD' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'state' IN ('settled','released','reconciliation_required'))))
 OR (NEW.resource_type='tenant' AND NEW.resource_id=NEW.tenant_id::text AND (
 (NEW.action='tenant.deletion_requested' AND NEW.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - 'deletion_scheduled_for'='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (NEW.action='tenant.restored' AND NEW.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'='{"via":"verified_identity_recovery"}'::jsonb)
 OR (NEW.action='tenant.updated' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'source'='tenant_erasure' AND (
 (NEW.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - ARRAY['source','stage','attempt']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT ((CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' ? 'attempt') OR (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (NEW.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'='{"source":"tenant_erasure"}'::jsonb)))
 OR (NEW.action='tenant.deleted' AND NEW.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (NEW.action='tenant.updated' AND NEW.reason IS NULL AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'source'='tenant_erasure_runtime_cleanup' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'revisions' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'secret_versions' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'restart_requests' ~ '^[0-9]{1,10}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (NEW.resource_type='hosted_work' AND NEW.action='hosted_work.reconciled' AND NEW.reason='operator_reviewed_owner_stop' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via' - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)->>'via'='token_exchange' THEN subkit.hosted_audit_metadata_without_provenance(NEW.metadata)-'via' ELSE subkit.hosted_audit_metadata_without_provenance(NEW.metadata) END)-'auth_via'->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))),false) THEN 0 ELSE 1 END); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'audit_log',v_bytes,v_count); END IF;
 RETURN NULL;
END $_$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_auth_provider_configs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."provider"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."config_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."config_iv"),0)::bigint + COALESCE(octet_length(OLD."config_auth_tag"),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."provider"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."config_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."config_iv"),0)::bigint + COALESCE(octet_length(NEW."config_auth_tag"),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'auth_provider_configs',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_catalog_categories() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."purpose"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."purpose_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."aliases"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."redirect_to"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."purpose"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."purpose_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."aliases"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."redirect_to"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'catalog_categories',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_chat_deliveries() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."thread_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."payload"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."status"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."thread_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."payload"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."status"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'chat_deliveries',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_chat_identities() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."platform"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."platform_user_id"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."platform"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."platform_user_id"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'chat_identities',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_chat_sessions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."thread_id"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."thread_id"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'chat_sessions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_chat_workspaces() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."default_channel"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."bot_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."bot_iv"),0)::bigint + COALESCE(octet_length(OLD."bot_auth_tag"),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."default_channel"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."bot_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."bot_iv"),0)::bigint + COALESCE(octet_length(NEW."bot_auth_tag"),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'chat_workspaces',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_cli_notification_inbox() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."event_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."event_payload"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."resource_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."resource_id"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."event_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."event_payload"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."resource_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."resource_id"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'cli_notification_inbox',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_cli_notification_inbox_reads() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(0::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(0::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'cli_notification_inbox_reads',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_cockpit_installations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."device_label"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."device_label"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'cockpit_installations',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_cockpit_push_keys() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;



 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(OLD."ciphertext"),0)::bigint + COALESCE(octet_length(OLD."iv"),0)::bigint + COALESCE(octet_length(OLD."auth_tag"),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(NEW."ciphertext"),0)::bigint + COALESCE(octet_length(NEW."iv"),0)::bigint + COALESCE(octet_length(NEW."auth_tag"),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'cockpit_push_keys',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_cockpit_push_subscriptions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;



 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."endpoint_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."ciphertext"),0)::bigint + COALESCE(octet_length(OLD."iv"),0)::bigint + COALESCE(octet_length(OLD."auth_tag"),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."endpoint_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."ciphertext"),0)::bigint + COALESCE(octet_length(NEW."iv"),0)::bigint + COALESCE(octet_length(NEW."auth_tag"),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'cockpit_push_subscriptions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_connector_document_chunks() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."tsv"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."embedding"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."embedding_model"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."tsv"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."embedding"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."embedding_model"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'connector_document_chunks',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_connector_documents() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."source_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."version"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."source_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."version"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'connector_documents',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_connector_endpoint_schemas() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."method"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."request_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."query_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."response_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."expected_statuses"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."source"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."method"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."request_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."query_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."response_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."expected_statuses"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."source"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'connector_endpoint_schemas',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_connector_environments() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."overrides"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."overrides"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'connector_environments',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_connector_mcp_sessions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."negotiated_protocol_version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."server_capabilities"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."tools_manifest_hash"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."negotiated_protocol_version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."server_capabilities"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."tools_manifest_hash"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'connector_mcp_sessions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_connector_promotions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."idempotency_key_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."request_fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."strategy"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."response"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."idempotency_key_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."request_fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."strategy"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."response"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'connector_promotions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_connector_templates() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."driver"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."auth_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."oauth"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."default_skill"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."ingestion_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."ingestion_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."icon"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."aliases"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."setup_instructions"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."auth_options"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."url_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."keywords"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."inline_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."probe_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."credential_hints"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."base_url_options"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."pagination_defaults"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."capabilities"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."driver"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."auth_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."oauth"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."default_skill"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."ingestion_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."ingestion_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."icon"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."aliases"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."setup_instructions"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."auth_options"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."url_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."keywords"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."inline_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."probe_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."credential_hints"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."base_url_options"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."pagination_defaults"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."capabilities"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'connector_templates',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_connectors() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."driver"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."config"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."dsn"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."operator_quirks"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."self_description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."template_slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."template_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."template_snapshot"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."auto_refresh_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."circuit_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."auth_failed_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."health_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."health_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."health_error_code"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."successor_uri"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."driver"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."config"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."dsn"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."operator_quirks"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."self_description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."template_slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."template_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."template_snapshot"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."auto_refresh_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."circuit_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."auth_failed_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."health_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."health_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."health_error_code"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."successor_uri"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'connectors',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_conversation_draft_snapshots() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."draft"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."label"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."draft"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."label"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'conversation_draft_snapshots',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_conversation_drafts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."ordinal"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."snapshot"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."ordinal"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."snapshot"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'conversation_drafts',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_conversation_elicitations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."tool_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."summary"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."output"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."delivery_last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."decision_reason"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."tool_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."summary"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."output"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."delivery_last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."decision_reason"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'conversation_elicitations',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_conversation_hidden() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(0::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(0::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'conversation_hidden',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_conversation_messages() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."model"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."model"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'conversation_messages',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_conversation_tool_calls() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."tool"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."output"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."confirmation_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."outcome"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."confirmation_data"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."interaction_log"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."tool"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."output"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."confirmation_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."outcome"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."confirmation_data"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."interaction_log"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'conversation_tool_calls',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_conversations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."draft"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."last_turn_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."model"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."memory"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."loaded_skills"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."tool_policies"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."topic_embedding"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."topic_embedding_model"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."origin_client"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."surface"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."draft"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."last_turn_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."model"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."memory"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."loaded_skills"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."tool_policies"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."topic_embedding"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."topic_embedding_model"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."origin_client"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."surface"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'conversations',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_deliveries() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."classification"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."terminal_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."request_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."event_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."target_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."response_body"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."classification"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."terminal_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."request_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."event_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."target_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."response_body"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'deliveries',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_discovery_artifacts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."draft"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."evidence"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."materialized_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."materialized_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."rejection_reason"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."draft"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."evidence"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."materialized_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."materialized_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."rejection_reason"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'discovery_artifacts',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_discovery_files() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."filename"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."mime_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."format"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."fingerprint"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."filename"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."mime_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."format"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."fingerprint"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'discovery_files',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_discovery_runs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."label"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."token_usage"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."error"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."label"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."token_usage"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."error"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'discovery_runs',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_events() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."channel"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."payload"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."channel"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."payload"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'events',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_execution_fixtures() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."request"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."response"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."body"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."request"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."response"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."body"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'execution_fixtures',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_execution_steps() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."step_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."input_preview"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."output_preview"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."result_storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."result_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."result_preview"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."request_meta"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."credential_snapshots"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."placeholders_used"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."redacted_fields"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."step_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."input_preview"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."output_preview"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."result_storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."result_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."result_preview"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."request_meta"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."credential_snapshots"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."placeholders_used"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."redacted_fields"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'execution_steps',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_executions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."tool_approval_dispatches"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."source_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."source_ref"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."caller_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."caller_origin"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."authorization_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."sensitive_result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."request_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."authority_call_path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."result_storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."result_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."idempotency_key"::text,'UTF8')),0)::bigint + CASE WHEN subkit.hosted_content_quota_terminal('executions',to_jsonb(OLD)) THEN 0::bigint ELSE COALESCE(octet_length(convert_to(OLD."failure"::text,'UTF8')),0)::bigint END + COALESCE(octet_length(convert_to(OLD."output_contract"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."guard_bucket"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."guard_unit_key"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."tool_approval_dispatches"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."source_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."source_ref"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."caller_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."caller_origin"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."authorization_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."sensitive_result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."request_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."authority_call_path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."result_storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."result_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."idempotency_key"::text,'UTF8')),0)::bigint + CASE WHEN subkit.hosted_content_quota_terminal('executions',to_jsonb(NEW)) THEN 0::bigint ELSE COALESCE(octet_length(convert_to(NEW."failure"::text,'UTF8')),0)::bigint END + COALESCE(octet_length(convert_to(NEW."output_contract"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."guard_bucket"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."guard_unit_key"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'executions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_file_links() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."role"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."role"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'file_links',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_file_versions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."filename"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."content_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."sha256"::text,'UTF8')),0)::bigint + OLD."size_bytes"::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."filename"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."content_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."sha256"::text,'UTF8')),0)::bigint + NEW."size_bytes"::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'file_versions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_files() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 IF TG_OP<>'DELETE' AND NEW.size_bytes<0 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_file_size_invalid'; END IF;
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."filename"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."content_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."scan_result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."catalog_input_hash"::text,'UTF8')),0)::bigint + OLD."size_bytes"::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."filename"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."content_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."scan_result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."catalog_input_hash"::text,'UTF8')),0)::bigint + NEW."size_bytes"::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'files',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_group_members() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=(SELECT tenant_id FROM subkit."groups" WHERE id=OLD."group_id"); END IF;
 IF TG_OP<>'DELETE' THEN v_new:=(SELECT tenant_id FROM subkit."groups" WHERE id=NEW."group_id"); END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(0::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(0::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'group_members',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_group_role_assignments() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=(SELECT tenant_id FROM subkit."groups" WHERE id=OLD."group_id"); END IF;
 IF TG_OP<>'DELETE' THEN v_new:=(SELECT tenant_id FROM subkit."groups" WHERE id=NEW."group_id"); END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(0::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(0::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'group_role_assignments',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_groups() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'groups',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_hosted_storage_objects() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 IF TG_OP='UPDATE' AND (OLD.tenant_id,OLD.storage_key,OLD.storage_namespace,OLD.declared_bytes) IS DISTINCT FROM (NEW.tenant_id,NEW.storage_key,NEW.storage_namespace,NEW.declared_bytes) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_object_reservation_immutable'; END IF;
 IF TG_OP='DELETE' AND (OLD.state<>'absence_verified' OR OLD.absence_verified_at IS NULL) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_object_absence_unverified'; END IF;
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(OLD."declared_bytes"::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(NEW."declared_bytes"::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'hosted_storage_objects',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_intake_category_defaults() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'intake_category_defaults',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_intake_item_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."agent"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."session_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."repo"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."excerpt"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."recorded_by_type"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."agent"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."session_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."repo"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."excerpt"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."recorded_by_type"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'intake_item_evidence',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_intake_items() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."creation_request_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."original_snapshot"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."note"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."collected_by_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."admitted_target_kind"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."creation_request_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."original_snapshot"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."note"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."collected_by_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."admitted_target_kind"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'intake_items',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_intake_proposal_items() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."source_title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."source_url"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."source_title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."source_url"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'intake_proposal_items',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_intake_proposal_revisions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."target"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."created_by_type"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."target"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."created_by_type"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'intake_proposal_revisions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_intake_proposals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."confirmed_target_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."stale_reason"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."confirmed_target_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."stale_reason"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'intake_proposals',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_knowledge_chunks() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."tsv"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."embedding"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."embedding_model"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."tsv"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."embedding"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."embedding_model"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'knowledge_chunks',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_knowledge_source_versions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."content_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."note"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."content_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."note"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'knowledge_source_versions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_knowledge_sources() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."source_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."source_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."mime_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."refresh_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."refresh_webhook_secret"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."source_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."source_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."mime_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."refresh_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."refresh_webhook_secret"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'knowledge_sources',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_mcp_tasks() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."job_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."request_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."result"::text,'UTF8')),0)::bigint + CASE WHEN subkit.hosted_content_quota_terminal('mcp_tasks',to_jsonb(OLD)) THEN 0::bigint ELSE COALESCE(octet_length(convert_to(OLD."failure_reason"::text,'UTF8')),0)::bigint END + COALESCE(octet_length(convert_to(OLD."phase"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."last_action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."progress_step"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."parked_reason"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."job_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."request_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."result"::text,'UTF8')),0)::bigint + CASE WHEN subkit.hosted_content_quota_terminal('mcp_tasks',to_jsonb(NEW)) THEN 0::bigint ELSE COALESCE(octet_length(convert_to(NEW."failure_reason"::text,'UTF8')),0)::bigint END + COALESCE(octet_length(convert_to(NEW."phase"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."last_action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."progress_step"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."parked_reason"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'mcp_tasks',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_notification_channels() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."channel_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."platform"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."default_severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."circuit_state"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."channel_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."platform"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."default_severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."circuit_state"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'notification_channels',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_notification_deliveries() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."event_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."event_payload"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."error"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."event_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."event_payload"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."error"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'notification_deliveries',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_notification_rules() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."event_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."workflow_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."request_source_filter"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."target_workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."target_channel_id"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."event_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."workflow_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."request_source_filter"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."target_workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."target_channel_id"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'notification_rules',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_outbound_connection_starts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."state_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."code_verifier"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."redirect_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."issuer"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."authorization_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."token_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."registration_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."client_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."service_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."service_description"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."state_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."code_verifier"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."redirect_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."issuer"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."authorization_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."token_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."registration_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."client_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."service_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."service_description"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'outbound_connection_starts',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_outbound_connections() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."issuer"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."authorization_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."token_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."registration_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."client_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."verified_identity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."granted_scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."service_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."service_description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."last_error"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."issuer"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."authorization_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."token_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."registration_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."client_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."verified_identity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."granted_scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."service_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."service_description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."last_error"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'outbound_connections',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_package_install_items() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."item_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."imported_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."local_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."state"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."item_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."imported_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."local_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."state"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'package_install_items',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_package_installs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."package_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."package_version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."format"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."content_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."installed_by_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."summary"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."package_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."package_version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."format"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."content_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."installed_by_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."summary"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'package_installs',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_patch_candidates() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."diff"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."closed_reason"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."diff"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."closed_reason"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'patch_candidates',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_portal_tokens() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."enduser_ref"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."prefix"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."allowed_workflows"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."enduser_ref"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."prefix"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."allowed_workflows"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'portal_tokens',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_request_hooks() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."role"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."stdlib_version"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."role"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."stdlib_version"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'request_hooks',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_resource_grants() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."subject_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."resource_type"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."subject_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."resource_type"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'resource_grants',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_role_permissions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=(SELECT tenant_id FROM subkit."roles" WHERE id=OLD."role_id"); END IF;
 IF TG_OP<>'DELETE' THEN v_new:=(SELECT tenant_id FROM subkit."roles" WHERE id=NEW."role_id"); END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(0::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(0::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'role_permissions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_roles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'roles',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_runtime_secret_versions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."ciphertext"),0)::bigint + COALESCE(octet_length(OLD."iv"),0)::bigint + COALESCE(octet_length(OLD."auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(OLD."prepared_by"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."pending_bindings"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."ciphertext"),0)::bigint + COALESCE(octet_length(NEW."iv"),0)::bigint + COALESCE(octet_length(NEW."auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(NEW."prepared_by"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."pending_bindings"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'runtime_secret_versions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_schema_versions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."step_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."observed_schema"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."step_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."observed_schema"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'schema_versions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_self_healing_scans() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."filters"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."idempotency_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."error"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."filters"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."idempotency_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."error"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'self_healing_scans',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_skill_candidate_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=(SELECT tenant_id FROM subkit."skill_candidates" WHERE id=OLD."skill_candidate_id"); END IF;
 IF TG_OP<>'DELETE' THEN v_new:=(SELECT tenant_id FROM subkit."skill_candidates" WHERE id=NEW."skill_candidate_id"); END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."evidence_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."summary"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."evidence_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."summary"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'skill_candidate_evidence',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_skill_candidates() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."examples"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."evidence"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."tags"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."examples"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."evidence"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."tags"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'skill_candidates',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_skill_effectiveness() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(0::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(0::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'skill_effectiveness',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_skills() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."examples"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."arguments"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."seed_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."gates_tools"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."activates_when"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."input_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."output_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."side_effects"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."idempotency"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."maturity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."applies_to"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."examples"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."arguments"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."seed_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."gates_tools"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."activates_when"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."input_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."output_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."side_effects"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."idempotency"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."maturity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."applies_to"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'skills',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_subscriptions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."event_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."target_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."secret_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."secret_iv"),0)::bigint + COALESCE(octet_length(OLD."secret_auth_tag"),0)::bigint + COALESCE(octet_length(OLD."rotating_secret_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."rotating_secret_iv"),0)::bigint + COALESCE(octet_length(OLD."rotating_secret_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(OLD."filters"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."event_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."target_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."secret_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."secret_iv"),0)::bigint + COALESCE(octet_length(NEW."secret_auth_tag"),0)::bigint + COALESCE(octet_length(NEW."rotating_secret_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."rotating_secret_iv"),0)::bigint + COALESCE(octet_length(NEW."rotating_secret_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(NEW."filters"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'subscriptions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_system_accounts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'system_accounts',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_tasks() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."goal"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."done_when"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."plan"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."bindings"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."schedule_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."schedule_timezone"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."admission_hold_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."paused_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."lifecycle"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."goal"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."done_when"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."plan"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."bindings"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."schedule_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."schedule_timezone"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."admission_hold_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."paused_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."lifecycle"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'tasks',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_tenant_branding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;



 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."subtitle"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."logo_light"),0)::bigint + COALESCE(octet_length(OLD."logo_dark"),0)::bigint + COALESCE(octet_length(OLD."app_icon_192"),0)::bigint + COALESCE(octet_length(OLD."app_icon_512"),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."subtitle"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."logo_light"),0)::bigint + COALESCE(octet_length(NEW."logo_dark"),0)::bigint + COALESCE(octet_length(NEW."app_icon_192"),0)::bigint + COALESCE(octet_length(NEW."app_icon_512"),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'tenant_branding',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_tenant_skill_overrides() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."skill_slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."body_override"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."skill_slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."body_override"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'tenant_skill_overrides',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_tenants() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 IF TG_OP='UPDATE' AND OLD.origin IS DISTINCT FROM NEW.origin THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_origin_immutable'; END IF;
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(CASE WHEN OLD.deleted_at IS NOT NULL AND OLD.status='pending_deletion' AND OLD.display_name='Deleted workspace' AND OLD.slug ~ '^[0-9a-f-]{36}$' AND OLD.llm_primary IS NULL AND OLD.llm_fallback IS NULL AND OLD.egress_guard_mode IS NULL AND OLD.timezone='UTC' THEN 0::bigint ELSE COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."llm_primary"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."llm_fallback"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."timezone"::text,'UTF8')),0)::bigint END);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(CASE WHEN NEW.deleted_at IS NOT NULL AND NEW.status='pending_deletion' AND NEW.display_name='Deleted workspace' AND NEW.slug ~ '^[0-9a-f-]{36}$' AND NEW.llm_primary IS NULL AND NEW.llm_fallback IS NULL AND NEW.egress_guard_mode IS NULL AND NEW.timezone='UTC' THEN 0::bigint ELSE COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."llm_primary"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."llm_fallback"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."timezone"::text,'UTF8')),0)::bigint END);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'tenants',v_bytes,v_count); END IF;
 RETURN NULL;
END $_$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_tool_approvals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."caller_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."authorization_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."tool"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."surface"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."execution_mode"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."args_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."args_iv"),0)::bigint + COALESCE(octet_length(OLD."args_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(OLD."args_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."preview_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."preview_iv"),0)::bigint + COALESCE(octet_length(OLD."preview_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(OLD."portal_token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."granted_via"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."caller_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."authorization_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."tool"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."surface"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."execution_mode"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."args_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."args_iv"),0)::bigint + COALESCE(octet_length(NEW."args_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(NEW."args_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."preview_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."preview_iv"),0)::bigint + COALESCE(octet_length(NEW."preview_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(NEW."portal_token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."granted_via"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'tool_approvals',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_user_identities() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."provider_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."issuer_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."product_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."subject"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."email"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."provider_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."issuer_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."product_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."subject"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."email"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'user_identities',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_user_invites() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."prefix"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."allowed_workflows"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."allowed_connectors"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."prefix"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."allowed_workflows"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."allowed_connectors"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'user_invites',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_user_llm_settings() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(0::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(0::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'user_llm_settings',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_users() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."email"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."display_name"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."email"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."display_name"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'users',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_vault_items() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."verified_identity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."ciphertext"),0)::bigint + COALESCE(octet_length(OLD."iv"),0)::bigint + COALESCE(octet_length(OLD."auth_tag"),0)::bigint + COALESCE(octet_length(OLD."oauth2_refresh_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."oauth2_refresh_iv"),0)::bigint + COALESCE(octet_length(OLD."oauth2_refresh_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(OLD."granted_scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."template_slug"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."verified_identity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."ciphertext"),0)::bigint + COALESCE(octet_length(NEW."iv"),0)::bigint + COALESCE(octet_length(NEW."auth_tag"),0)::bigint + COALESCE(octet_length(NEW."oauth2_refresh_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."oauth2_refresh_iv"),0)::bigint + COALESCE(octet_length(NEW."oauth2_refresh_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(NEW."granted_scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."template_slug"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'vault_items',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_vendor_recipe_overrides() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."client"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."override"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."client"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."override"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'vendor_recipe_overrides',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_webhooks_inbound() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."verifier"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."native_verifier_config"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."secret_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."secret_iv"),0)::bigint + COALESCE(octet_length(OLD."secret_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(OLD."origin"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."admission_hold"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."verifier"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."native_verifier_config"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."secret_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."secret_iv"),0)::bigint + COALESCE(octet_length(NEW."secret_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(NEW."origin"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."admission_hold"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'webhooks_inbound',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_webhooks_outbound() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."signing_keys"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."circuit_state"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."signing_keys"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."circuit_state"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'webhooks_outbound',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_workflow_autoheal_policies() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(0::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(0::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'workflow_autoheal_policies',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_workflow_execution_authorities() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."effect_manifest_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."effect_manifest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."target_constraints"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."approved_manifest"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."effect_manifest_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."effect_manifest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."target_constraints"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."approved_manifest"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'workflow_execution_authorities',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_workflow_review_receipts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."snapshot"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."snapshot_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."status"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."snapshot"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."snapshot_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."status"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'workflow_review_receipts',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_workflow_run_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."ciphertext"),0)::bigint + COALESCE(octet_length(OLD."iv"),0)::bigint + COALESCE(octet_length(OLD."auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(OLD."value_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."note"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."ciphertext"),0)::bigint + COALESCE(octet_length(NEW."iv"),0)::bigint + COALESCE(octet_length(NEW."auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(NEW."value_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."note"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'workflow_run_state',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_workflow_signals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."event_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."payload"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."event_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."payload"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'workflow_signals',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_workflow_versions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."dag"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."note"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."authority_growth"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."scope_index"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."dag"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."note"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."authority_growth"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."scope_index"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'workflow_versions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_workflow_waits() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."step_id"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."step_id"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'workflow_waits',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_workflows() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."health_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."health_reason"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."health_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."health_reason"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'workflows',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_workflows_schedules() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."timezone"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."admission_hold"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."input_error"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."timezone"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."admission_hold"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."input_error"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'workflows_schedules',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_operational_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE j jsonb; field record; valid boolean:=true;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM subkit.tenants WHERE id=NEW.tenant_id AND origin='self_service') THEN RETURN NEW; END IF;
 j:=to_jsonb(NEW);
 FOR field IN SELECT key,value FROM jsonb_each_text(j) LOOP
  IF field.value IS NULL THEN CONTINUE; END IF;
  IF field.key IN ('error') AND TG_TABLE_NAME IN ('llm_usage','external_call_metering') THEN
   NEW.error:='provider_error';
  ELSIF field.key IN ('token_sha256','code_sha256','subject_sha256','state_sha256','evidence_sha256','actor_hmac','session_hmac') THEN
   valid:=valid AND field.value ~ '^[0-9a-f]{64}$';
  ELSIF field.key IN ('redirect_uri','authorization_url','authorization_endpoint','token_endpoint','registration_endpoint','as_issuer','issuer_url','base_url','resource') THEN
   valid:=valid AND octet_length(field.value)<=4096 AND field.value !~ '[[:cntrl:]]';
  ELSIF field.key='redirect_to' THEN
   valid:=valid AND octet_length(field.value)<=2048 AND field.value ~ '^/' AND field.value !~ '[[:cntrl:]]';
  ELSIF field.key IN ('state','code_verifier','nonce','code_challenge','prefix','platform_event_id','standard_webhook_id','drain_boot_id') THEN
   valid:=valid AND octet_length(field.value)<=256 AND field.value ~ '^[A-Za-z0-9._:/+@=-]+$';
  ELSIF jsonb_typeof(j->field.key)='string' THEN
   valid:=valid AND octet_length(field.value)<=512 AND field.value !~ '[[:cntrl:]]';
  END IF;
 END LOOP;
 IF TG_TABLE_NAME='hosted_storage_objects' THEN
  valid:=valid AND octet_length(j->>'storage_key')<=160
   AND j->>'storage_key' ~ ('^offload/'||NEW.tenant_id::text||'/([0-9a-f-]{36}/)?[0-9a-f-]{36}[.]json$')
   AND j->>'storage_namespace' ~ '^[0-9a-f]{64}$';
 ELSIF TG_TABLE_NAME='llm_usage' THEN
  valid:=valid AND j->>'flow'=ANY(ARRAY['generate','extract','catalog_describe','repair','tool_repair','converse','discover','summarize','suggest_next','critic_authoring','judge','workflow_step'])
   AND j->>'result'=ANY(ARRAY['success','quota_exhausted','context_too_large','error']) AND j->>'actor_type'=ANY(ARRAY['system','user','system_account'])
   AND j->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$';
 ELSIF TG_TABLE_NAME='hosted_work_admissions' THEN
  valid:=valid AND (j->>'queue_name' IS NULL OR j->>'queue_name'=ANY(ARRAY['execution.run','conversation.run-turn','chat.event','task.run-turn']))
   AND j->>'kind'=ANY(ARRAY['execution','chat']) AND j->>'state'=ANY(ARRAY['pending','active','reconciliation_required','released']);
 ELSIF TG_TABLE_NAME='caller_budget_units' THEN
  valid:=valid AND octet_length(j->>'unit_key')<=128 AND j->>'product_id' ~ '^[a-zA-Z0-9._:-]{1,128}$'
   AND j->>'bucket' ~ '^[a-zA-Z0-9._:-]{1,128}$';
 ELSIF TG_TABLE_NAME='usage_events' THEN
  valid:=valid AND j->>'surface'=ANY(ARRAY['http','chat','mcp','conversations']) AND j->>'traffic_class'=ANY(ARRAY['organic','synthetic','internal']);
 ELSIF TG_TABLE_NAME='tenant_erasure_states' THEN
  valid:=valid AND j->>'stage'=ANY(ARRAY['claimed','queue_cleared','objects_cleared','completed'])
   AND (j->>'failure_code' IS NULL OR j->>'failure_code'=ANY(ARRAY['tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed']));
 END IF;
 IF NOT COALESCE(valid,false) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_operational_metadata_invalid'; END IF;
 RETURN NEW;
END $_$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_singleton_control_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE valid boolean:=false;
BEGIN
 IF NOT subkit.hosted_singleton_control_receipt(to_jsonb(NEW)) THEN RETURN NEW; END IF;
 IF NEW.resource_type='execution' THEN
  PERFORM 1 FROM subkit.executions e WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.resource_id::uuid AND subkit.hosted_content_quota_terminal('executions',to_jsonb(e)) AND e.failure->>'error_code'=NEW.reason FOR KEY SHARE;
  valid:=FOUND;
 ELSIF NEW.resource_type='mcp_task' THEN
  PERFORM 1 FROM subkit.mcp_tasks t WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.resource_id::uuid AND subkit.hosted_content_quota_terminal('mcp_tasks',to_jsonb(t)) AND t.failure_reason=NEW.reason FOR KEY SHARE;
  valid:=FOUND;
 ELSIF NEW.resource_type='session' THEN
  PERFORM 1 FROM subkit.sessions s JOIN subkit.cockpit_installations i ON i.id=s.installation_id WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.resource_id::uuid AND s.installation_id=(NEW.metadata->>'installation_id')::uuid AND s.revoked_at IS NOT NULL AND i.tenant_id=NEW.tenant_id AND i.owner_user_id=NEW.actor_id AND i.revoked_at IS NOT NULL FOR KEY SHARE OF s,i;
  valid:=FOUND;
 ELSIF NEW.resource_type='cockpit_installation' THEN
  PERFORM 1 FROM subkit.cockpit_installations i WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.resource_id::uuid AND i.owner_user_id=NEW.actor_id AND i.revoked_at IS NOT NULL FOR KEY SHARE;
  valid:=FOUND;
 ELSE
  PERFORM 1 FROM subkit.hosted_storage_objects o WHERE o.tenant_id=NEW.tenant_id AND o.id=NEW.resource_id::uuid AND o.state='pending' AND o.storage_namespace=NEW.metadata->>'storage_namespace' FOR KEY SHARE;
  valid:=FOUND AND EXISTS(SELECT 1 FROM subkit.users u JOIN subkit.tenants t ON t.id=u.tenant_id WHERE u.id=NEW.actor_id AND t.id=(NEW.metadata->>'operator_tenant_id')::uuid AND t.is_operator AND t.status='active' AND t.deleted_at IS NULL AND u.status='active' AND u.deleted_at IS NULL);
 END IF;
 IF NOT valid THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_quota_control_receipt_invalid'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_singleton_control_receipt(j jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE kind text:=j->>'resource_type'; resource uuid; tenant uuid; metadata jsonb;
BEGIN
 IF NOT COALESCE(j->>'resource_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false) THEN RETURN false; END IF;
 resource:=(j->>'resource_id')::uuid;tenant:=(j->>'tenant_id')::uuid;
 IF (j->>'id')::uuid<>subkit.hosted_control_receipt_id(tenant,kind,resource) OR j->>'before' IS NOT NULL OR j->>'after' IS NOT NULL OR j->>'ip' IS NOT NULL OR j->>'user_agent' IS NOT NULL OR COALESCE(length(j->>'trace_id'),0)>128 THEN RETURN false; END IF;
 metadata:=subkit.hosted_audit_metadata_without_provenance(j->'metadata');
 IF metadata IS NULL THEN RETURN false; END IF;
 IF kind IN ('execution','mcp_task') THEN
  RETURN COALESCE(j->>'actor_type'='system' AND j->>'actor_id' IS NULL AND j->>'result'='denied'
   AND j->>'reason' IN ('hosted_storage_quota_exhausted','hosted_resource_count_exhausted')
   AND metadata=jsonb_build_object('code',j->>'reason')
   AND j->>'action'=CASE kind WHEN 'execution' THEN 'execution.failed' ELSE 'conversation.turn_failed' END,false);
 END IF;
 IF kind='session' THEN
  RETURN COALESCE(j->>'actor_type'='user' AND j->>'actor_id' IS NOT NULL AND j->>'result'='success' AND j->>'action'='session.revoked' AND j->>'reason'='installation_revoked' AND (metadata)-ARRAY['installation_id']='{}'::jsonb AND (j#>>'{metadata,installation_id}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false);
 END IF;
 IF kind='cockpit_installation' THEN
  RETURN COALESCE(j->>'actor_type'='user' AND j->>'actor_id' IS NOT NULL AND j->>'result'='success' AND j->>'action'='cockpit_installation.revoked' AND j->>'reason' IS NULL AND (metadata)-ARRAY['revoked_session_count']='{}'::jsonb AND j#>>'{metadata,revoked_session_count}' ~ '^(0|[1-9][0-9]{0,8})$',false);
 END IF;
 IF kind='hosted_storage_object' THEN
  RETURN COALESCE(j->>'actor_type'='user' AND j->>'actor_id' IS NOT NULL AND j->>'result'='success'
   AND j->>'action'='hosted_storage_object.reconciled' AND j->>'reason'='operator_reviewed_remote_upload_stop'
   AND (metadata)-ARRAY['storage_namespace','evidence_sha256','operator_tenant_id']='{}'::jsonb
   AND j#>>'{metadata,storage_namespace}' ~ '^[0-9a-f]{64}$' AND j#>>'{metadata,evidence_sha256}' ~ '^[0-9a-f]{64}$'
   AND j#>>'{metadata,operator_tenant_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false);
 END IF;
 RETURN false;
END $_$;
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_terminal_receipt_required() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE j jsonb; kind text;
BEGIN
 IF TG_TABLE_NAME='executions' THEN
  SELECT to_jsonb(e) INTO j FROM subkit.executions e WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.id;
  kind:='execution';
 ELSE
  SELECT to_jsonb(t) INTO j FROM subkit.mcp_tasks t WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.id;
  kind:='mcp_task';
 END IF;
 IF NOT subkit.hosted_content_quota_terminal(TG_TABLE_NAME,j) OR NOT EXISTS(SELECT 1 FROM subkit.tenants WHERE id=NEW.tenant_id AND origin='self_service') THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM subkit.audit_log a WHERE a.id=subkit.hosted_control_receipt_id(NEW.tenant_id,kind,NEW.id) AND a.tenant_id=NEW.tenant_id AND subkit.hosted_singleton_control_receipt(to_jsonb(a)) AND a.reason=CASE kind WHEN 'execution' THEN j#>>'{failure,error_code}' ELSE j->>'failure_reason' END) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_quota_terminal_receipt_required'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.rbac_check_group_member_tenant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE group_tenant uuid; user_tenant uuid;
BEGIN
 SELECT g.tenant_id,u.tenant_id INTO group_tenant,user_tenant
 FROM subkit.groups g CROSS JOIN subkit.users u
 WHERE g.id=NEW.group_id AND u.id=NEW.user_id FOR SHARE OF g,u;
 IF NOT FOUND OR group_tenant IS DISTINCT FROM user_tenant THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='rbac_group_member_tenant_mismatch',CONSTRAINT='rbac_group_member_tenant';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.rbac_check_group_role_tenant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE group_tenant uuid; role_tenant uuid;
BEGIN
 SELECT g.tenant_id,r.tenant_id INTO group_tenant,role_tenant
 FROM subkit.groups g CROSS JOIN subkit.roles r
 WHERE g.id=NEW.group_id AND r.id=NEW.role_id FOR SHARE OF g,r;
 IF NOT FOUND OR (role_tenant IS NOT NULL AND group_tenant IS DISTINCT FROM role_tenant) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='rbac_group_role_tenant_mismatch',CONSTRAINT='rbac_group_role_tenant';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.rbac_check_parent_tenant_transfer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN RETURN NEW; END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='rbac_tenant_transfer_requires_read_committed';
 END IF;
 IF TG_TABLE_NAME='groups' THEN
  IF EXISTS(SELECT 1 FROM subkit.group_members m JOIN subkit.users u ON u.id=m.user_id WHERE m.group_id=OLD.id AND u.tenant_id IS DISTINCT FROM NEW.tenant_id)
   OR EXISTS(SELECT 1 FROM subkit.group_role_assignments a JOIN subkit.roles r ON r.id=a.role_id WHERE a.group_id=OLD.id AND r.tenant_id IS NOT NULL AND r.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='rbac_group_tenant_transfer_conflict',CONSTRAINT='rbac_parent_tenant_transfer';
  END IF;
 ELSIF TG_TABLE_NAME='users' THEN
  IF EXISTS(SELECT 1 FROM subkit.group_members m JOIN subkit.groups g ON g.id=m.group_id WHERE m.user_id=OLD.id AND g.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='rbac_user_tenant_transfer_conflict',CONSTRAINT='rbac_parent_tenant_transfer';
  END IF;
 ELSIF TG_TABLE_NAME='roles' AND NEW.tenant_id IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM subkit.group_role_assignments a JOIN subkit.groups g ON g.id=a.group_id WHERE a.role_id=OLD.id AND g.tenant_id IS DISTINCT FROM NEW.tenant_id)
   OR EXISTS(SELECT 1 FROM subkit.users u WHERE u.role_id=OLD.id AND u.tenant_id IS DISTINCT FROM NEW.tenant_id)
   OR EXISTS(SELECT 1 FROM subkit.system_accounts s WHERE s.role_id=OLD.id AND s.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='rbac_role_tenant_transfer_conflict',CONSTRAINT='rbac_parent_tenant_transfer';
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.reserve_execution_authority() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'subkit'
    AS $$
BEGIN
  IF NEW.execution_authority_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status <> 'queued' THEN
    RAISE EXCEPTION 'authorized executions must be admitted as queued' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM "subkit"."workflows"
   WHERE id = NEW.workflow_id AND tenant_id = NEW.tenant_id
     AND current_version_id = NEW.workflow_version_id
     AND lifecycle = 'active' AND deleted_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution authority requires the exact active workflow version' USING ERRCODE = '23514';
  END IF;
  UPDATE "subkit"."workflow_execution_authorities"
     SET reserved_runs = reserved_runs + 1
   WHERE id = NEW.execution_authority_id AND tenant_id = NEW.tenant_id
     AND workflow_id = NEW.workflow_id AND workflow_version_id = NEW.workflow_version_id
     AND execution_environment = NEW.execution_mode
     AND revoked_at IS NULL AND valid_from <= clock_timestamp()
     AND (valid_until IS NULL OR valid_until > clock_timestamp())
     AND (max_runs IS NULL OR reserved_runs < max_runs);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution authority is unavailable or exhausted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.runtime_secret_owner(p_name text) RETURNS uuid
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
BEGIN
 IF p_name LIKE 'connection.%' THEN
  IF p_name !~ '^connection[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][a-z0-9][a-z0-9-]{0,62}[.](access_token|refresh_token)$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_review_required'; END IF;
  RETURN split_part(p_name,'.',2)::uuid;
 ELSIF p_name LIKE 'tenants.%' THEN
  IF p_name !~ '^tenants[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][A-Za-z0-9._-]+$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_review_required'; END IF;
  RETURN split_part(p_name,'.',2)::uuid;
 END IF;
 RETURN NULL;
END $_$;
--> statement-breakpoint
CREATE FUNCTION subkit.runtime_secret_owner_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE expected uuid; tenant_origin text; tenant_status text; tenant_deleted timestamptz;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.tenant_id,OLD.name,OLD.version) IS DISTINCT FROM (NEW.tenant_id,NEW.name,NEW.version) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_immutable'; END IF;
 expected:=subkit.runtime_secret_owner(NEW.name);
 IF NEW.tenant_id IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM expected THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_invalid'; END IF;
 NEW.tenant_id:=expected;
 IF expected IS NOT NULL THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(expected::text,741937)) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='hosted_quota_concurrent_write'; END IF;
  SELECT origin::text,status::text,deleted_at INTO tenant_origin,tenant_status,tenant_deleted FROM subkit.tenants WHERE id=expected FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_invalid'; END IF;
  IF (tenant_status<>'active' OR tenant_deleted IS NOT NULL) AND (TG_OP='INSERT' OR (NEW.ciphertext,NEW.iv,NEW.auth_tag,NEW.prepared_by,NEW.pending_bindings) IS DISTINCT FROM (OLD.ciphertext,OLD.iv,OLD.auth_tag,OLD.prepared_by,OLD.pending_bindings)) AND NOT subkit.vault_maintenance_update_allowed(to_jsonb(OLD),to_jsonb(NEW)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_inactive'; END IF;
  IF TG_OP='INSERT' AND tenant_origin='self_service' AND NEW.name LIKE 'tenants.%' AND NEW.name<>'tenants.'||expected::text||'.settings.llm.api_key' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_runtime_secret_overlay_forbidden'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_gate_held(p_exclusive boolean) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'subkit', 'pg_temp'
    AS $$
 SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_catalog.pg_backend_pid() AND l.granted AND l.objsubid=1 AND l.classid=((pg_catalog.hashtextextended('subkit.runtime.vault-maintenance',0)>>32)&4294967295)::oid AND l.objid=(pg_catalog.hashtextextended('subkit.runtime.vault-maintenance',0)&4294967295)::oid AND (l.mode='ExclusiveLock' OR (NOT p_exclusive AND l.mode='ShareLock')))
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_maintenance_apply(p_operation uuid, p_page_sha256 text, p_rows subkit.vault_cipher_replacement[], p_finish boolean) RETURNS TABLE(applied_count integer, unchanged_count integer, result_epoch bigint, audit_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'subkit', 'pg_temp'
    AS $$
DECLARE b jsonb; s subkit.runtime_config_state%ROWTYPE; c jsonb; entry subkit.vault_cipher_replacement; row subkit.runtime_secret_versions%ROWTYPE; payload subkit.vault_cipher_snapshot[]:='{}'; metadata_hash text; total bigint:=0; changed integer:=0; unchanged_counted integer:=0; result_key_epoch bigint; receipt uuid; receipt_hex text; last_name text; last_version integer;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('subkit.runtime.vault-maintenance',0));
 b:=subkit.vault_maintenance_authorize();
 LOCK TABLE subkit.auth_provider_configs,subkit.chat_workspaces,subkit.execution_steps,subkit.executions,subkit.subscriptions,subkit.tool_approvals,subkit.vault_items,subkit.webhooks_inbound,subkit.workflow_run_state IN SHARE MODE;
 LOCK TABLE subkit.runtime_secret_versions IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO s FROM subkit.runtime_config_state WHERE key='runtime' FOR UPDATE;
 IF subkit.vault_non_registry_stock_present() THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='vault_non_registry_stock_unsupported'; END IF;
 IF EXISTS(SELECT 1 FROM subkit.runtime_config_replicas) OR EXISTS(SELECT 1 FROM subkit.hosted_work_admissions WHERE state<>'released') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='vault_maintenance_producers_unresolved'; END IF;
 c:=s.vault_maintenance_context;
 IF c IS NULL OR p_rows IS NULL OR p_finish IS NULL OR cardinality(p_rows)>128 OR cardinality(p_rows)<>(c->>'row_count')::integer OR c->>'pending'<>'true' OR c->>'operation_id' IS DISTINCT FROM p_operation::text OR c->>'transaction_id'<>pg_catalog.txid_current()::text OR c->>'binding_sha256'<>encode(public.digest(b::text,'sha256'),'hex') OR c->>'page_sha256' IS DISTINCT FROM p_page_sha256 OR p_finish=(c->>'has_more')::boolean OR (c->>'source_epoch')::bigint<>s.master_key_epoch THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_page_invalid'; END IF;
 IF (SELECT count(*) FROM unnest(p_rows) e WHERE NOT e.unchanged)<>(SELECT count(DISTINCT e.replacement_iv) FROM unnest(p_rows) e WHERE NOT e.unchanged) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_envelope_invalid'; END IF;
 FOREACH entry IN ARRAY p_rows LOOP
  IF entry.name IS NULL OR length(entry.name)>255 OR entry.version IS NULL OR entry.version<1 OR entry.unchanged IS NULL OR (last_name IS NOT NULL AND (entry.name,entry.version)<=(last_name,last_version)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_page_invalid'; END IF;
  last_name:=entry.name;last_version:=entry.version;
  SELECT * INTO row FROM subkit.runtime_secret_versions WHERE name=entry.name AND version=entry.version FOR UPDATE;
  IF NOT FOUND OR row.ciphertext IS DISTINCT FROM entry.expected_ciphertext OR row.iv IS DISTINCT FROM entry.expected_iv OR row.auth_tag IS DISTINCT FROM entry.expected_auth_tag THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='vault_maintenance_cas_conflict'; END IF;
  metadata_hash:=encode(public.digest((to_jsonb(row)-ARRAY['ciphertext','iv','auth_tag'])::text,'sha256'),'hex');
  payload:=array_append(payload,ROW(row.name,row.version,row.tenant_id,row.ciphertext,row.iv,row.auth_tag,metadata_hash)::subkit.vault_cipher_snapshot);
  total:=total+octet_length(row.ciphertext)+octet_length(row.iv)+octet_length(row.auth_tag)+COALESCE(octet_length(entry.replacement_ciphertext),0)+COALESCE(octet_length(entry.replacement_iv),0)+COALESCE(octet_length(entry.replacement_auth_tag),0);
  IF total>134217728 THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='vault_maintenance_page_too_large'; END IF;
  IF entry.unchanged THEN
   IF entry.replacement_ciphertext IS NOT NULL OR entry.replacement_iv IS NOT NULL OR entry.replacement_auth_tag IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_envelope_invalid'; END IF;
  ELSIF entry.replacement_ciphertext IS NULL OR entry.replacement_iv IS NULL OR entry.replacement_auth_tag IS NULL OR octet_length(entry.replacement_ciphertext)<>octet_length(row.ciphertext) OR octet_length(entry.replacement_iv)<>12 OR octet_length(entry.replacement_auth_tag)<>16 OR entry.replacement_iv=row.iv OR EXISTS(SELECT 1 FROM subkit.runtime_secret_versions v WHERE v.iv=entry.replacement_iv) OR (row.ciphertext,row.iv,row.auth_tag) IS NOT DISTINCT FROM (entry.replacement_ciphertext,entry.replacement_iv,entry.replacement_auth_tag) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_envelope_invalid'; END IF;
 END LOOP;
 IF encode(public.digest(to_jsonb(payload)::text,'sha256'),'hex')<>p_page_sha256 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='vault_maintenance_cas_conflict'; END IF;
 UPDATE subkit.runtime_config_state SET vault_maintenance_context=c||jsonb_build_object('applying',true) WHERE key='runtime';
 FOREACH entry IN ARRAY p_rows LOOP
  IF entry.unchanged THEN unchanged_counted:=unchanged_counted+1;
  ELSE
   UPDATE subkit.runtime_secret_versions SET ciphertext=entry.replacement_ciphertext,iv=entry.replacement_iv,auth_tag=entry.replacement_auth_tag WHERE name=entry.name AND version=entry.version;
   changed:=changed+1;
  END IF;
 END LOOP;
 result_key_epoch:=s.master_key_epoch;
 IF s.master_key_digest IS DISTINCT FROM c->>'target_digest' THEN result_key_epoch:=result_key_epoch+1; END IF;
 receipt_hex:=substr(encode(public.digest('offline-vault:'||p_operation::text||':'||(c->>'page_number'),'sha256'),'hex'),1,32);
 receipt:=overlay(overlay(receipt_hex placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid;
 IF changed>0 OR (p_finish AND result_key_epoch<>s.master_key_epoch) THEN
  INSERT INTO subkit.audit_log(id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,result,reason,trace_id,metadata) VALUES(receipt,'00000000-0000-0000-0000-000000000000','system',NULL,'secret.master_key_rewrapped','runtime_secret',p_operation::text,'success','offline_key_rewrap','',jsonb_build_object('operation_id',p_operation,'page_number',(c->>'page_number')::integer,'replaced_count',changed,'unchanged_count',unchanged_counted,'source_epoch',s.master_key_epoch,'target_epoch',result_key_epoch,'source_key_digest',s.master_key_digest,'target_key_digest',c->>'target_digest','evidence_sha256',c->>'evidence_sha256','page_sha256',p_page_sha256,'binding_sha256',c->>'binding_sha256'));
 ELSE receipt:=NULL;
 END IF;
 IF p_finish THEN
  UPDATE subkit.runtime_config_state SET master_key_epoch=result_key_epoch,master_key_digest=c->>'target_digest',vault_maintenance_context=NULL WHERE key='runtime';
 ELSE
  UPDATE subkit.runtime_config_state SET vault_maintenance_context=(c-ARRAY['page_sha256','row_count','tail_name','tail_version','has_more'])||jsonb_build_object('after_name',c->'tail_name','after_version',c->'tail_version','pending',false,'applying',false,'page_number',(c->>'page_number')::integer+1) WHERE key='runtime';
 END IF;
 RETURN QUERY SELECT changed,unchanged_counted,result_key_epoch,receipt;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_maintenance_authorize() RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'subkit', 'pg_temp'
    AS $_$
DECLARE b jsonb; role_entry jsonb; runtime_oid oid; maintenance_oid oid; definer_oid oid; snapshot_oid oid; apply_oid oid; status_oid oid; role_count integer;
BEGIN
 SELECT vault_maintenance_binding INTO b FROM subkit.runtime_config_state WHERE key='runtime';
 IF b IS NULL OR jsonb_typeof(b)<>'object' OR b-ARRAY['binding_id','maintenance_login','definer','runtime_logins','inventory_evidence_sha256']<>'{}'::jsonb OR COALESCE(b->>'binding_id','') !~ '^[0-9a-f-]{36}$' OR COALESCE(b->>'inventory_evidence_sha256','') !~ '^[0-9a-f]{64}$' OR jsonb_typeof(b->'runtime_logins') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 IF jsonb_array_length(b->'runtime_logins') NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 SELECT p.oid,p.proowner INTO snapshot_oid,definer_oid FROM pg_catalog.pg_proc p WHERE p.oid='subkit.vault_maintenance_snapshot(uuid,bigint,text,text,text,integer,integer)'::regprocedure;
 SELECT p.oid INTO apply_oid FROM pg_catalog.pg_proc p WHERE p.oid='subkit.vault_maintenance_apply(uuid,text,subkit.vault_cipher_replacement[],boolean)'::regprocedure AND p.proowner=definer_oid;
 SELECT p.oid INTO status_oid FROM pg_catalog.pg_proc p WHERE p.oid='subkit.vault_maintenance_status()'::regprocedure AND p.proowner=definer_oid;
 SELECT r.oid INTO maintenance_oid FROM pg_catalog.pg_roles r WHERE r.rolname=session_user AND r.rolcanlogin;
 IF apply_oid IS NULL OR status_oid IS NULL OR maintenance_oid IS NULL OR current_user::text IS DISTINCT FROM (SELECT rolname::text FROM pg_catalog.pg_roles WHERE oid=definer_oid) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 FOR role_entry IN SELECT value FROM jsonb_array_elements(jsonb_build_array(b->'maintenance_login',b->'definer')||(b->'runtime_logins')) LOOP
  IF jsonb_typeof(role_entry)<>'object' OR role_entry-ARRAY['oid','name']<>'{}'::jsonb OR COALESCE(role_entry->>'oid','') !~ '^[1-9][0-9]{0,9}$' OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid::text=role_entry->>'oid' AND rolname=role_entry->>'name') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 END LOOP;
 IF b#>>'{maintenance_login,oid}'<>maintenance_oid::text OR b#>>'{definer,oid}'<>definer_oid::text OR maintenance_oid=definer_oid OR subkit.vault_role_owner_equivalent(maintenance_oid) OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=snapshot_oid),pg_catalog.acldefault('f',definer_oid))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=apply_oid),pg_catalog.acldefault('f',definer_oid))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=status_oid),pg_catalog.acldefault('f',definer_oid))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='subkit' AND c.relkind IN ('r','p','v','m','f') AND (pg_catalog.has_table_privilege(maintenance_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(maintenance_oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 SELECT count(DISTINCT value->>'oid') INTO role_count FROM jsonb_array_elements(b->'runtime_logins');
 IF role_count<>jsonb_array_length(b->'runtime_logins') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 FOR role_entry IN SELECT value FROM jsonb_array_elements(b->'runtime_logins') LOOP
  runtime_oid:=(role_entry->>'oid')::oid;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=runtime_oid AND rolcanlogin) OR runtime_oid IN (maintenance_oid,definer_oid) OR subkit.vault_role_owner_equivalent(runtime_oid) OR pg_catalog.pg_has_role(runtime_oid,maintenance_oid,'MEMBER') OR pg_catalog.pg_has_role(runtime_oid,definer_oid,'MEMBER') OR pg_catalog.pg_has_role(maintenance_oid,runtime_oid,'MEMBER') OR pg_catalog.has_function_privilege(runtime_oid,snapshot_oid,'EXECUTE') OR pg_catalog.has_function_privilege(runtime_oid,apply_oid,'EXECUTE') OR pg_catalog.has_function_privilege(runtime_oid,status_oid,'EXECUTE') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 END LOOP;
 RETURN b;
END $_$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_maintenance_commit_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'subkit', 'pg_temp'
    AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM subkit.runtime_config_state WHERE key=NEW.key AND vault_maintenance_context IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='vault_maintenance_incomplete'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_maintenance_context_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'subkit', 'pg_temp'
    AS $$
DECLARE state_owner oid; auth_oid oid; trusted boolean; c jsonb;
BEGIN
 SELECT c.relowner INTO state_owner FROM pg_catalog.pg_class c WHERE c.oid='subkit.runtime_config_state'::regclass;
 SELECT oid INTO auth_oid FROM pg_catalog.pg_roles WHERE rolname=session_user;
 trusted:=pg_catalog.pg_has_role(auth_oid,state_owner,'MEMBER') OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=auth_oid AND rolsuper);
 IF TG_OP='DELETE' THEN
  IF NOT trusted THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_key_marker_forbidden'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.vault_maintenance_context IS NOT NULL OR (NEW.vault_maintenance_binding IS NOT NULL AND NOT trusted) OR NEW.master_key_epoch<>0 OR (NEW.master_key_digest IS NOT NULL AND (NOT trusted OR NOT subkit.vault_gate_held(false))) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_key_marker_forbidden'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.key IS DISTINCT FROM OLD.key THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_key_marker_forbidden'; END IF;
 IF NEW.vault_maintenance_binding IS DISTINCT FROM OLD.vault_maintenance_binding AND NOT trusted THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_binding_forbidden'; END IF;
 IF NEW.master_key_epoch IS DISTINCT FROM OLD.master_key_epoch OR NEW.master_key_digest IS DISTINCT FROM OLD.master_key_digest THEN
  c:=OLD.vault_maintenance_context;
  IF OLD.master_key_digest IS NULL AND OLD.master_key_epoch=0 AND NEW.master_key_epoch=0 AND NEW.master_key_digest IS NOT NULL AND NEW.vault_maintenance_context IS NULL AND trusted AND subkit.vault_gate_held(false) THEN
   NULL;
  ELSIF c IS NOT NULL AND c->>'applying'='true' AND c->>'transaction_id'=pg_catalog.txid_current()::text AND c->>'target_digest'=NEW.master_key_digest AND NEW.vault_maintenance_context IS NULL AND NEW.master_key_epoch=OLD.master_key_epoch+(CASE WHEN OLD.master_key_digest IS DISTINCT FROM NEW.master_key_digest THEN 1 ELSE 0 END) AND subkit.vault_gate_held(true) THEN
   PERFORM subkit.vault_maintenance_authorize();
  ELSIF trusted AND OLD.vault_maintenance_context IS NULL AND NEW.vault_maintenance_context IS NULL AND subkit.vault_gate_held(true) AND NEW.master_key_digest IS NOT NULL AND NEW.master_key_epoch=OLD.master_key_epoch+1 AND OLD.master_key_digest IS DISTINCT FROM NEW.master_key_digest AND subkit.vault_stock_frozen() AND NOT EXISTS(SELECT 1 FROM subkit.runtime_config_replicas) AND NOT EXISTS(SELECT 1 FROM subkit.hosted_work_admissions WHERE state<>'released') THEN
   IF subkit.vault_non_registry_stock_present() THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='vault_non_registry_stock_unsupported'; END IF;
  ELSE RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_key_marker_forbidden'; END IF;
 END IF;
 IF NEW.vault_maintenance_context IS DISTINCT FROM OLD.vault_maintenance_context THEN PERFORM subkit.vault_maintenance_authorize(); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_maintenance_snapshot(p_operation uuid, p_expected_epoch bigint, p_target_key_sha256 text, p_evidence_sha256 text, p_after_name text, p_after_version integer, p_limit integer DEFAULT 128) RETURNS subkit.vault_snapshot_page
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'subkit', 'pg_temp'
    AS $_$
DECLARE b jsonb; s subkit.runtime_config_state%ROWTYPE; c jsonb; row subkit.runtime_secret_versions%ROWTYPE; payload subkit.vault_cipher_snapshot[]:='{}'; bytes bigint:=0; page_hash text; more boolean:=false; tail_name text; tail_version integer; page_number integer; metadata_hash text; result subkit.vault_snapshot_page;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('subkit.runtime.vault-maintenance',0));
 b:=subkit.vault_maintenance_authorize();
 LOCK TABLE subkit.auth_provider_configs,subkit.chat_workspaces,subkit.execution_steps,subkit.executions,subkit.subscriptions,subkit.tool_approvals,subkit.vault_items,subkit.webhooks_inbound,subkit.workflow_run_state IN SHARE MODE;
 LOCK TABLE subkit.runtime_secret_versions IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO s FROM subkit.runtime_config_state WHERE key='runtime' FOR UPDATE;
 IF subkit.vault_non_registry_stock_present() THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='vault_non_registry_stock_unsupported'; END IF;
 IF p_operation IS NULL OR p_expected_epoch IS NULL OR p_expected_epoch<>s.master_key_epoch OR COALESCE(p_target_key_sha256,'') !~ '^[0-9a-f]{64}$' OR COALESCE(p_evidence_sha256,'') !~ '^[0-9a-f]{64}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 128 OR (p_after_name IS NULL)<>(p_after_version IS NULL) OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_request_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM subkit.runtime_config_replicas) OR EXISTS(SELECT 1 FROM subkit.hosted_work_admissions WHERE state<>'released') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='vault_maintenance_producers_unresolved'; END IF;
 c:=s.vault_maintenance_context;
 IF c IS NULL THEN
  IF p_after_name IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_cursor_invalid'; END IF;
  c:=jsonb_build_object('operation_id',p_operation,'transaction_id',pg_catalog.txid_current()::text,'binding_sha256',encode(public.digest(b::text,'sha256'),'hex'),'source_epoch',s.master_key_epoch,'source_digest',s.master_key_digest,'target_digest',p_target_key_sha256,'evidence_sha256',p_evidence_sha256,'page_number',1,'after_name',NULL,'after_version',NULL,'pending',false,'applying',false);
 ELSE
  IF c->>'operation_id'<>p_operation::text OR c->>'transaction_id'<>pg_catalog.txid_current()::text OR c->>'binding_sha256'<>encode(public.digest(b::text,'sha256'),'hex') OR c->>'target_digest'<>p_target_key_sha256 OR c->>'evidence_sha256'<>p_evidence_sha256 OR c->>'pending'<>'false' OR c->>'after_name' IS DISTINCT FROM p_after_name OR (c->>'after_version')::integer IS DISTINCT FROM p_after_version THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_cursor_invalid'; END IF;
 END IF;
 page_number:=(c->>'page_number')::integer;
 FOR row IN SELECT * FROM subkit.runtime_secret_versions WHERE p_after_name IS NULL OR (name,version)>(p_after_name,p_after_version) ORDER BY name,version LIMIT p_limit+1 LOOP
  IF cardinality(payload)>=p_limit OR bytes+octet_length(row.ciphertext)+octet_length(row.iv)+octet_length(row.auth_tag)>67108864 THEN more:=true; EXIT; END IF;
  bytes:=bytes+octet_length(row.ciphertext)+octet_length(row.iv)+octet_length(row.auth_tag);
  metadata_hash:=encode(public.digest((to_jsonb(row)-ARRAY['ciphertext','iv','auth_tag'])::text,'sha256'),'hex');
  payload:=array_append(payload,ROW(row.name,row.version,row.tenant_id,row.ciphertext,row.iv,row.auth_tag,metadata_hash)::subkit.vault_cipher_snapshot);
  tail_name:=row.name;tail_version:=row.version;
 END LOOP;
 IF cardinality(payload)=0 AND more THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='vault_maintenance_page_too_large'; END IF;
 page_hash:=encode(public.digest(to_jsonb(payload)::text,'sha256'),'hex');
 c:=c||jsonb_build_object('pending',true,'page_sha256',page_hash,'row_count',cardinality(payload),'tail_name',tail_name,'tail_version',tail_version,'has_more',more);
 UPDATE subkit.runtime_config_state SET vault_maintenance_context=c WHERE key='runtime';
 result:=ROW(p_operation,page_number,s.master_key_epoch,page_hash,more,payload)::subkit.vault_snapshot_page;
 RETURN result;
END $_$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_maintenance_status() RETURNS TABLE(key_epoch bigint, key_digest text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'subkit', 'pg_temp'
    AS $$
BEGIN
 PERFORM subkit.vault_maintenance_authorize();
 RETURN QUERY SELECT s.master_key_epoch,s.master_key_digest FROM subkit.runtime_config_state s WHERE s.key='runtime';
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_maintenance_update_allowed(p_old jsonb, p_new jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'subkit', 'pg_temp'
    AS $$
DECLARE b jsonb; c jsonb;
BEGIN
 SELECT vault_maintenance_binding,vault_maintenance_context INTO b,c FROM subkit.runtime_config_state WHERE key='runtime';
 IF c IS NULL OR b#>>'{maintenance_login,name}' IS DISTINCT FROM session_user::text OR b#>>'{definer,name}' IS DISTINCT FROM current_user::text THEN RETURN false; END IF;
 PERFORM subkit.vault_maintenance_authorize();
 RETURN subkit.vault_gate_held(true) AND c->>'transaction_id'=pg_catalog.txid_current()::text AND c->>'binding_sha256'=encode(public.digest(b::text,'sha256'),'hex') AND c->>'applying'='true' AND p_old-ARRAY['ciphertext','iv','auth_tag']=p_new-ARRAY['ciphertext','iv','auth_tag'] AND octet_length(decode(substr(p_old->>'ciphertext',3),'hex'))=octet_length(decode(substr(p_new->>'ciphertext',3),'hex')) AND octet_length(decode(substr(p_new->>'iv',3),'hex'))=12 AND octet_length(decode(substr(p_new->>'auth_tag',3),'hex'))=16;
END $$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_non_registry_stock_present() RETURNS boolean
    LANGUAGE sql STABLE
    AS $_$
SELECT EXISTS (SELECT 1 FROM subkit."auth_provider_configs" stock WHERE stock."config_ciphertext" IS NOT NULL OR stock."config_iv" IS NOT NULL OR stock."config_auth_tag" IS NOT NULL)
 OR EXISTS (SELECT 1 FROM subkit."chat_workspaces" stock WHERE stock."bot_ciphertext" IS NOT NULL OR stock."bot_iv" IS NOT NULL OR stock."bot_auth_tag" IS NOT NULL)
 OR EXISTS (SELECT 1 FROM subkit."execution_steps" stock WHERE (stock."output_preview" IS NOT NULL AND (jsonb_path_exists(stock."output_preview", '$.** ? (@."$sensitive" == true)') OR jsonb_path_exists(stock."output_preview", '$.** ? (exists(@.ciphertext) && exists(@.iv) && exists(@.auth_tag))'))) OR (stock."request_meta" #> '{extras,prepared_request_proof}' IS NOT NULL AND stock."request_meta" #> '{extras,prepared_request_proof}' <> 'null'::jsonb))
 OR EXISTS (SELECT 1 FROM subkit."executions" stock WHERE (stock."input" IS NOT NULL AND (jsonb_path_exists(stock."input", '$.** ? (@."$sensitive" == true)') OR jsonb_path_exists(stock."input", '$.** ? (exists(@.ciphertext) && exists(@.iv) && exists(@.auth_tag))'))) OR (stock."source_ref" IS NOT NULL AND (jsonb_path_exists(stock."source_ref", '$.** ? (@."$sensitive" == true)') OR jsonb_path_exists(stock."source_ref", '$.** ? (exists(@.ciphertext) && exists(@.iv) && exists(@.auth_tag))'))) OR (stock."sensitive_result" IS NOT NULL AND (jsonb_path_exists(stock."sensitive_result", '$.** ? (@."$sensitive" == true)') OR jsonb_path_exists(stock."sensitive_result", '$.** ? (exists(@.ciphertext) && exists(@.iv) && exists(@.auth_tag))'))) OR (stock."tool_approval_dispatches" IS NOT NULL AND stock."tool_approval_dispatches" <> '{}'::jsonb AND stock."tool_approval_dispatches" <> 'null'::jsonb))
 OR EXISTS (SELECT 1 FROM subkit."subscriptions" stock WHERE stock."secret_ciphertext" IS NOT NULL OR stock."secret_iv" IS NOT NULL OR stock."secret_auth_tag" IS NOT NULL OR stock."rotating_secret_ciphertext" IS NOT NULL OR stock."rotating_secret_iv" IS NOT NULL OR stock."rotating_secret_auth_tag" IS NOT NULL)
 OR EXISTS (SELECT 1 FROM subkit."tool_approvals" stock WHERE stock."args_ciphertext" IS NOT NULL OR stock."args_iv" IS NOT NULL OR stock."args_auth_tag" IS NOT NULL OR stock."preview_ciphertext" IS NOT NULL OR stock."preview_iv" IS NOT NULL OR stock."preview_auth_tag" IS NOT NULL)
 OR EXISTS (SELECT 1 FROM subkit."vault_items" stock WHERE stock."ciphertext" IS NOT NULL OR stock."iv" IS NOT NULL OR stock."auth_tag" IS NOT NULL OR stock."oauth2_refresh_ciphertext" IS NOT NULL OR stock."oauth2_refresh_iv" IS NOT NULL OR stock."oauth2_refresh_auth_tag" IS NOT NULL)
 OR EXISTS (SELECT 1 FROM subkit."webhooks_inbound" stock WHERE stock."secret_ciphertext" IS NOT NULL OR stock."secret_iv" IS NOT NULL OR stock."secret_auth_tag" IS NOT NULL)
 OR EXISTS (SELECT 1 FROM subkit."workflow_run_state" stock WHERE stock."ciphertext" IS NOT NULL OR stock."iv" IS NOT NULL OR stock."auth_tag" IS NOT NULL);
$_$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_role_owner_equivalent(p_role oid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'subkit', 'pg_temp'
    AS $$
 SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role(p_role,r.oid,'MEMBER') AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_signal_backend','pg_checkpoint','pg_maintain','pg_database_owner')))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database() AND pg_catalog.pg_has_role(p_role,d.datdba,'MEMBER'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='subkit' AND pg_catalog.pg_has_role(p_role,n.nspowner,'MEMBER'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='subkit' AND pg_catalog.pg_has_role(p_role,c.relowner,'MEMBER'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='subkit' AND pg_catalog.pg_has_role(p_role,p.proowner,'MEMBER'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='subkit' AND pg_catalog.pg_has_role(p_role,t.typowner,'MEMBER'))
 OR pg_catalog.has_schema_privilege(p_role,'subkit','CREATE')
$$;
--> statement-breakpoint
CREATE FUNCTION subkit.vault_stock_frozen() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'subkit', 'pg_temp'
    AS $$
 SELECT count(DISTINCT c.relname)=9 FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid=l.relation JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_catalog.pg_backend_pid() AND l.granted AND l.locktype='relation' AND l.mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock') AND n.nspname='subkit' AND c.relname=ANY(ARRAY['auth_provider_configs','chat_workspaces','execution_steps','executions','subscriptions','tool_approvals','vault_items','webhooks_inbound','workflow_run_state'])
$$;
--> statement-breakpoint
CREATE TABLE subkit.api_keys (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    system_account_id uuid,
    prefix text NOT NULL,
    token_sha256 text NOT NULL,
    scopes jsonb NOT NULL,
    allowed_workflows jsonb,
    allowed_connectors jsonb,
    not_before timestamp with time zone,
    expires_at timestamp with time zone,
    rotating_out_at timestamp with time zone,
    last_used_at timestamp with time zone,
    rotated_from_id uuid,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    creator_kind subkit.audit_actor_kind,
    creator_id uuid,
    credential_origin text,
    CONSTRAINT api_keys_creator_identity_check CHECK ((((creator_kind IS NULL) AND (creator_id IS NULL)) OR ((creator_kind IS NOT NULL) AND (creator_kind = 'system'::subkit.audit_actor_kind) AND (creator_id IS NULL)) OR ((creator_kind IS NOT NULL) AND (creator_kind = ANY (ARRAY['user'::subkit.audit_actor_kind, 'system_account'::subkit.audit_actor_kind])) AND (creator_id IS NOT NULL)))),
    CONSTRAINT api_keys_credential_origin_check CHECK (((credential_origin IS NULL) OR (credential_origin = 'cli_oauth_session'::text)))
);
--> statement-breakpoint
CREATE TABLE subkit.audit_log (
    id uuid NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    result text NOT NULL,
    trace_id text,
    ip text,
    user_agent text,
    before jsonb,
    after jsonb,
    reason text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'system_account'::text, 'system'::text, 'unknown'::text]))),
    CONSTRAINT audit_log_result_check CHECK ((result = ANY (ARRAY['success'::text, 'denied'::text, 'error'::text]))),
    CONSTRAINT audit_log_unknown_actor_id_check CHECK (((actor_type <> 'unknown'::text) OR (actor_id IS NULL)))
);
--> statement-breakpoint
CREATE TABLE subkit.auth_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    issuer_url text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.auth_provider_configs (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    provider text NOT NULL,
    priority integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    config_ciphertext bytea,
    config_iv bytea,
    config_auth_tag bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.caller_budget_units (
    tenant_id uuid NOT NULL,
    product_id text NOT NULL,
    bucket text NOT NULL,
    principal_id uuid NOT NULL,
    unit_key text NOT NULL,
    day date NOT NULL,
    state text NOT NULL,
    billable boolean DEFAULT false NOT NULL,
    metered integer DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone NOT NULL,
    charged_execution_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT caller_budget_units_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'committed'::text, 'refunded'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.catalog_categories (
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    purpose text,
    purpose_source text,
    aliases jsonb DEFAULT '[]'::jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    redirect_to text,
    purpose_pending boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    purpose_attempted_at timestamp with time zone,
    CONSTRAINT catalog_categories_aliases_array CHECK (((jsonb_typeof(aliases) = 'array'::text) AND (jsonb_array_length(aliases) <= 32))),
    CONSTRAINT catalog_categories_purpose_length CHECK ((length(purpose) <= 2000)),
    CONSTRAINT catalog_categories_redirect_not_self CHECK (((redirect_to IS NULL) OR (redirect_to <> name))),
    CONSTRAINT catalog_categories_revision_positive CHECK ((revision > 0)),
    CONSTRAINT catalog_categories_source_valid CHECK ((purpose_source = ANY (ARRAY['human'::text, 'llm'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.chat_composer_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    file_id uuid NOT NULL,
    slug text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_composer_attachments_slug_check CHECK (((char_length(slug) >= 1) AND (char_length(slug) <= 255)))
);
--> statement-breakpoint
CREATE TABLE subkit.chat_deliveries (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    thread_id text,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.chat_events_seen (
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    platform_event_id text NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.chat_identities (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    workspace_id text NOT NULL,
    platform_user_id text NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.chat_sessions (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    thread_id text NOT NULL,
    conversation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.chat_workspaces (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    platform subkit.chat_platform NOT NULL,
    workspace_id text NOT NULL,
    default_channel text,
    bot_ciphertext bytea NOT NULL,
    bot_iv bytea NOT NULL,
    bot_auth_tag bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.cli_notification_inbox (
    id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    delivery_id uuid,
    severity text NOT NULL,
    event_type text NOT NULL,
    event_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actionable boolean DEFAULT false NOT NULL,
    resource_type text,
    resource_id text
);
--> statement-breakpoint
CREATE SEQUENCE subkit.cli_notification_inbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE subkit.cli_notification_inbox_id_seq OWNED BY subkit.cli_notification_inbox.id;
--> statement-breakpoint
CREATE TABLE subkit.cli_notification_inbox_reads (
    tenant_id uuid NOT NULL,
    inbox_id bigint NOT NULL,
    user_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.cockpit_installations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'browser'::text NOT NULL,
    device_id uuid,
    device_label text,
    CONSTRAINT cockpit_installations_device_check CHECK ((((kind = 'desktop'::text) AND (device_id IS NOT NULL) AND (device_label IS NOT NULL)) OR ((kind = 'browser'::text) AND (device_id IS NULL) AND (device_label IS NULL)))),
    CONSTRAINT cockpit_installations_kind_check CHECK ((kind = ANY (ARRAY['browser'::text, 'desktop'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.cockpit_push_keys (
    tenant_id uuid NOT NULL,
    ciphertext bytea NOT NULL,
    iv bytea NOT NULL,
    auth_tag bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.cockpit_push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    installation_id uuid,
    session_id uuid NOT NULL,
    endpoint_sha256 text NOT NULL,
    ciphertext bytea NOT NULL,
    iv bytea NOT NULL,
    auth_tag bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notified_attention_keys text[],
    notified_at timestamp with time zone,
    kind text DEFAULT 'installation'::text NOT NULL,
    user_id uuid,
    device_sha256 text,
    auto_pause_notified_at timestamp with time zone,
    CONSTRAINT cockpit_push_subscriptions_kind_check CHECK ((((kind = 'installation'::text) AND (installation_id IS NOT NULL) AND (user_id IS NULL)) OR ((kind = 'browser'::text) AND (installation_id IS NULL) AND (user_id IS NOT NULL))))
);
--> statement-breakpoint
CREATE TABLE subkit.connector_credential_setup_grants (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connector_id uuid NOT NULL,
    token_sha256 text NOT NULL,
    created_by_actor_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.connector_document_chunks (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connector_id uuid NOT NULL,
    document_id uuid NOT NULL,
    ordinal integer NOT NULL,
    title text,
    path text,
    content text NOT NULL,
    byte_size integer NOT NULL,
    fingerprint text NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((((COALESCE(title, ''::text) || ' '::text) || COALESCE(path, ''::text)) || ' '::text) || content))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding real[],
    embedding_model text
);
--> statement-breakpoint
CREATE TABLE subkit.connector_documents (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connector_id uuid NOT NULL,
    source_type subkit.doc_source_type NOT NULL,
    source_uri text NOT NULL,
    version text NOT NULL,
    bytes_total integer DEFAULT 0 NOT NULL,
    chunk_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE subkit.connector_endpoint_schemas (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connector_id uuid NOT NULL,
    path text NOT NULL,
    method text NOT NULL,
    request_schema jsonb,
    query_schema jsonb,
    response_schema jsonb,
    expected_statuses integer[],
    idempotent boolean DEFAULT false NOT NULL,
    description text,
    source text DEFAULT 'manual'::text NOT NULL,
    confidence integer DEFAULT 0 NOT NULL,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.connector_environments (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connector_id uuid NOT NULL,
    environment subkit.environment NOT NULL,
    overrides jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.connector_mcp_sessions (
    connector_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    negotiated_protocol_version text,
    server_capabilities jsonb,
    tools_manifest_hash text,
    last_handshake_at timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    backoff_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.connector_oauth_start_grants (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connector_id uuid NOT NULL,
    token_sha256 text NOT NULL,
    created_by_actor_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.connector_oauth_states (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connector_id uuid NOT NULL,
    state text NOT NULL,
    code_verifier text NOT NULL,
    redirect_uri text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    requested_scopes text,
    origin text
);
--> statement-breakpoint
CREATE TABLE subkit.connector_promotions (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_fingerprint text NOT NULL,
    source_connector_id uuid NOT NULL,
    target_connector_id uuid NOT NULL,
    strategy text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.connector_templates (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    driver text NOT NULL,
    base_url text NOT NULL,
    auth_type text NOT NULL,
    oauth jsonb,
    default_skill text,
    ingestion_source text NOT NULL,
    ingestion_url text,
    icon text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    category text,
    tags jsonb DEFAULT '[]'::jsonb,
    aliases jsonb DEFAULT '[]'::jsonb NOT NULL,
    setup_instructions text DEFAULT ''::text NOT NULL,
    auth_options jsonb DEFAULT '[]'::jsonb,
    version integer DEFAULT 1 NOT NULL,
    url_pattern text DEFAULT ''::text NOT NULL,
    keywords jsonb DEFAULT '[]'::jsonb NOT NULL,
    inline_schema jsonb,
    probe_endpoint jsonb,
    credential_hints jsonb DEFAULT '[]'::jsonb NOT NULL,
    base_url_options jsonb DEFAULT '[]'::jsonb NOT NULL,
    pagination_defaults jsonb,
    capabilities jsonb DEFAULT '{"webhooks": false, "rate_limits": null, "webhook_events": []}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.connectors (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    driver text NOT NULL,
    environment subkit.environment DEFAULT 'dev'::subkit.environment NOT NULL,
    auth_type subkit.credential_mode DEFAULT 'none'::subkit.credential_mode NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    base_url text,
    dsn text,
    operator_quirks jsonb DEFAULT '{}'::jsonb NOT NULL,
    template_slug text,
    template_name text,
    template_source subkit.connector_template_source,
    template_version integer,
    template_snapshot jsonb,
    auto_refresh_cron text,
    last_ingested_at timestamp with time zone,
    circuit_state text DEFAULT 'closed'::text NOT NULL,
    circuit_opened_at timestamp with time zone,
    circuit_failure_count integer DEFAULT 0 NOT NULL,
    circuit_threshold integer DEFAULT 5 NOT NULL,
    circuit_reset_ms integer DEFAULT 300000 NOT NULL,
    needs_reauth boolean DEFAULT false NOT NULL,
    auth_failed_at timestamp with time zone,
    auth_failed_reason text,
    health_state text DEFAULT 'ok'::text NOT NULL,
    health_reason text,
    health_error_code text,
    health_changed_at timestamp with time zone,
    sunset_at timestamp with time zone,
    successor_uri text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    self_description jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_error text,
    description text,
    category text DEFAULT 'other'::text NOT NULL,
    description_source text DEFAULT 'llm'::text NOT NULL,
    category_source text DEFAULT 'llm'::text NOT NULL,
    catalog_input_hash text,
    catalog_described_at timestamp with time zone,
    CONSTRAINT connectors_catalog_sources CHECK (((description_source = ANY (ARRAY['human'::text, 'llm'::text])) AND (category_source = ANY (ARRAY['human'::text, 'llm'::text])))),
    CONSTRAINT connectors_category_format CHECK (((category ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (length(category) <= 40))),
    CONSTRAINT connectors_mcp_auth_no_inline_secrets_check CHECK (((((config -> 'mcp'::text) -> 'auth'::text) IS NULL) OR (NOT ((((config -> 'mcp'::text) -> 'auth'::text) ? 'client_secret'::text) OR (((config -> 'mcp'::text) -> 'auth'::text) ? 'password'::text) OR (((config -> 'mcp'::text) -> 'auth'::text) ? 'passphrase'::text) OR (((config -> 'mcp'::text) -> 'auth'::text) ? 'api_key'::text) OR (((config -> 'mcp'::text) -> 'auth'::text) ? 'apikey'::text) OR (((config -> 'mcp'::text) -> 'auth'::text) ? 'access_token'::text) OR (((config -> 'mcp'::text) -> 'auth'::text) ? 'refresh_token'::text) OR (((config -> 'mcp'::text) -> 'auth'::text) ? 'bearer_token'::text) OR (((config -> 'mcp'::text) -> 'auth'::text) ? 'secret'::text))))),
    CONSTRAINT connectors_slug_shape_check CHECK (((slug ~ '^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$'::text) AND (slug !~ '__'::text)))
);
--> statement-breakpoint
CREATE TABLE subkit.conversation_draft_snapshots (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    turn_index integer NOT NULL,
    draft jsonb NOT NULL,
    label text,
    snapshot_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.conversation_drafts (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    ordinal text NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.conversation_elicitations (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    tool_call_id uuid,
    parent_message_id uuid,
    tool_name text NOT NULL,
    summary text NOT NULL,
    input jsonb NOT NULL,
    output jsonb,
    status subkit.elicitation_status DEFAULT 'pending'::subkit.elicitation_status NOT NULL,
    protocol_native boolean DEFAULT false NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    decision_reason text,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_lease_id uuid,
    delivery_lease_expires_at timestamp with time zone,
    delivery_attempts integer DEFAULT 0 NOT NULL,
    delivery_last_error text,
    decided_by_kind subkit.audit_actor_kind,
    playbook_context_fingerprint text,
    CONSTRAINT conversation_elicitations_decided_by_kind_check CHECK ((((decided_by_kind IS NULL) AND (decided_by IS NULL)) OR ((decided_by_kind = 'unknown'::subkit.audit_actor_kind) AND (decided_by IS NULL)) OR ((decided_by_kind IS NOT NULL) AND (decided_by_kind = ANY (ARRAY['user'::subkit.audit_actor_kind, 'system_account'::subkit.audit_actor_kind])) AND (decided_by IS NOT NULL))))
);
--> statement-breakpoint
CREATE TABLE subkit.conversation_hidden (
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    hidden_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.conversation_messages (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    role subkit.conversation_role NOT NULL,
    content jsonb NOT NULL,
    tokens_in integer,
    tokens_out integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    model text
);
--> statement-breakpoint
CREATE TABLE subkit.conversation_tool_calls (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    parent_message_id uuid,
    tool text NOT NULL,
    input jsonb NOT NULL,
    output jsonb,
    approval_required boolean DEFAULT false NOT NULL,
    approved_at timestamp with time zone,
    approved_by_user_id uuid,
    confirmation_state text,
    confirmation_data jsonb,
    interaction_log jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    outcome text
);
--> statement-breakpoint
CREATE TABLE subkit.conversation_turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    attempt_id uuid,
    task_id uuid,
    worker_id uuid,
    cancel_requested boolean DEFAULT false NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.conversations (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    target_workflow_id uuid,
    target_connector_id uuid,
    draft jsonb,
    status subkit.conversation_status NOT NULL,
    owner_id uuid,
    model text,
    title text,
    memory text,
    loaded_skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    tool_policies jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    turn_count integer DEFAULT 0 NOT NULL,
    topic_embedding real[],
    topic_embedding_model text,
    origin_client text,
    surface text,
    title_locked boolean DEFAULT false NOT NULL,
    last_turn_error jsonb,
    playbook jsonb,
    playbook_revision integer DEFAULT 0 NOT NULL,
    playbook_mode text DEFAULT 'auto'::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.data_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.deliveries (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    event_id uuid NOT NULL,
    outbox_event_id bigint,
    attempt integer NOT NULL,
    attempt_number integer DEFAULT 1 NOT NULL,
    status text NOT NULL,
    response_code integer,
    error text,
    classification text,
    terminal_reason text,
    request_hash text,
    event_type text,
    target_url text,
    response_body text,
    duration_ms integer,
    next_retry_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.desktop_login_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    auth_identity_id uuid,
    code_sha256 text NOT NULL,
    code_challenge text NOT NULL,
    state_sha256 text NOT NULL,
    device_id uuid NOT NULL,
    device_label text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.device_allowances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    device_runner_id uuid NOT NULL,
    kind text NOT NULL,
    item_id text NOT NULL,
    display text NOT NULL,
    digest text,
    access text,
    private boolean,
    keep_out_target text,
    entered_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    CONSTRAINT device_allowances_digest_check CHECK ((((kind = 'keep_out'::text) = (digest IS NULL)) AND ((digest IS NULL) OR (digest ~ '^[a-f0-9]{64}$'::text)))),
    CONSTRAINT device_allowances_entered_by_check CHECK ((entered_by = ANY (ARRAY['person'::text, 'approval'::text]))),
    CONSTRAINT device_allowances_kind_check CHECK ((kind = ANY (ARRAY['folder'::text, 'site'::text, 'app'::text, 'keep_out'::text]))),
    CONSTRAINT device_allowances_shape_check CHECK ((((kind = 'folder'::text) = (access IS NOT NULL)) AND ((access IS NULL) OR (access = ANY (ARRAY['read'::text, 'write'::text]))) AND ((kind = 'site'::text) = (private IS NOT NULL)) AND ((kind = 'keep_out'::text) = (keep_out_target IS NOT NULL)) AND ((keep_out_target IS NULL) OR ((keep_out_target = ANY (ARRAY['folder'::text, 'app'::text])) AND (entered_by = 'person'::text))) AND ((kind <> 'site'::text) OR (NOT private) OR (entered_by = 'person'::text)))),
    CONSTRAINT device_allowances_size_check CHECK ((((char_length(item_id) >= 1) AND (char_length(item_id) <= 300)) AND ((char_length(display) >= 1) AND (char_length(display) <= 1024))))
);
--> statement-breakpoint
CREATE TABLE subkit.device_commands (
    id text NOT NULL,
    tenant_id uuid NOT NULL,
    device_id uuid NOT NULL,
    execution_id uuid,
    task_run_id uuid,
    step_id text NOT NULL,
    authority_id uuid,
    manifest_digest text,
    kind text NOT NULL,
    effect text NOT NULL,
    args jsonb NOT NULL,
    state text NOT NULL,
    generation integer NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    claimed_at timestamp with time zone,
    last_progress_at timestamp with time zone,
    finished_at timestamp with time zone,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    conversation_id uuid,
    CONSTRAINT device_commands_counts_check CHECK (((generation >= 0) AND ((attempt >= 1) AND (attempt <= 2)) AND ((char_length(step_id) >= 1) AND (char_length(step_id) <= 300)) AND ((char_length(kind) >= 1) AND (char_length(kind) <= 40)))),
    CONSTRAINT device_commands_effect_check CHECK ((effect = ANY (ARRAY['read'::text, 'write'::text]))),
    CONSTRAINT device_commands_finished_check CHECK (((state = ANY (ARRAY['pending'::text, 'claimed'::text])) = (finished_at IS NULL))),
    CONSTRAINT device_commands_id_check CHECK ((id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT device_commands_owner_check CHECK ((num_nonnulls(execution_id, task_run_id, conversation_id) = 1)),
    CONSTRAINT device_commands_size_check CHECK (((octet_length((args)::text) <= 262144) AND ((result IS NULL) OR (octet_length((result)::text) <= 1048576)))),
    CONSTRAINT device_commands_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'claimed'::text, 'done'::text, 'refused'::text, 'confirmation_required'::text, 'failed'::text, 'stopped'::text, 'cancelled'::text, 'lost'::text, 'expired'::text, 'revoked'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.device_runner_nonces (
    tenant_id uuid NOT NULL,
    device_runner_id uuid NOT NULL,
    nonce text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT device_runner_nonces_nonce_check CHECK ((nonce ~ '^[A-Za-z0-9_-]{22}$'::text))
);
--> statement-breakpoint
CREATE TABLE subkit.device_runners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    installation_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    device_label text NOT NULL,
    public_key text NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    last_heartbeat_at timestamp with time zone,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    app_version text,
    stop_generation integer DEFAULT 0 NOT NULL,
    reported_stop_generation integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_runners_capabilities_check CHECK (((jsonb_typeof(capabilities) = 'object'::text) AND (octet_length((capabilities)::text) <= 4096))),
    CONSTRAINT device_runners_generation_check CHECK (((stop_generation >= 0) AND (reported_stop_generation >= 0) AND (reported_stop_generation <= stop_generation))),
    CONSTRAINT device_runners_label_check CHECK (((char_length(device_label) >= 1) AND (char_length(device_label) <= 120))),
    CONSTRAINT device_runners_public_key_check CHECK (((char_length(public_key) >= 1) AND (char_length(public_key) <= 512))),
    CONSTRAINT device_runners_revoked_check CHECK (((revoked_at IS NULL) = (revoked_reason IS NULL)))
);
--> statement-breakpoint
CREATE TABLE subkit.device_upload_chunks (
    upload_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    n integer NOT NULL,
    bytes bytea NOT NULL,
    CONSTRAINT device_upload_chunks_size_check CHECK ((((n >= 0) AND (n <= 4095)) AND (octet_length(bytes) <= 4194304)))
);
--> statement-breakpoint
CREATE TABLE subkit.device_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    device_id uuid NOT NULL,
    command_id text NOT NULL,
    name text NOT NULL,
    size_bytes bigint NOT NULL,
    state text NOT NULL,
    file_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_uploads_size_check CHECK ((((size_bytes >= 0) AND (size_bytes <= 94371840)) AND ((char_length(name) >= 1) AND (char_length(name) <= 255)))),
    CONSTRAINT device_uploads_state_check CHECK (((state = ANY (ARRAY['open'::text, 'committed'::text, 'aborted'::text, 'expired'::text])) AND ((state = 'committed'::text) = (file_id IS NOT NULL))))
);
--> statement-breakpoint
CREATE TABLE subkit.device_waits (
    execution_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    device_id uuid NOT NULL,
    waiting_since timestamp with time zone NOT NULL,
    cap_at timestamp with time zone NOT NULL,
    CONSTRAINT device_waits_cap_check CHECK ((cap_at > waiting_since))
);
--> statement-breakpoint
CREATE TABLE subkit.discovery_artifacts (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    kind subkit.discovery_artifact_kind NOT NULL,
    status subkit.discovery_artifact_status DEFAULT 'proposed'::subkit.discovery_artifact_status NOT NULL,
    title text NOT NULL,
    description text,
    draft jsonb NOT NULL,
    evidence jsonb NOT NULL,
    confidence integer,
    materialized_id text,
    materialized_type text,
    rejection_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.discovery_files (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    filename text NOT NULL,
    mime_type text,
    byte_size integer NOT NULL,
    format text NOT NULL,
    content text,
    chunk_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    fingerprint text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.discovery_runs (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid,
    status subkit.discovery_run_status DEFAULT 'pending'::subkit.discovery_run_status NOT NULL,
    label text,
    file_count integer DEFAULT 0 NOT NULL,
    files_analyzed integer DEFAULT 0 NOT NULL,
    artifact_count integer DEFAULT 0 NOT NULL,
    token_usage jsonb DEFAULT '{"total_tokens": 0, "prompt_tokens": 0, "completion_tokens": 0}'::jsonb,
    error text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.engine_restart_requests (
    key text NOT NULL,
    request jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.engine_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);
--> statement-breakpoint
CREATE TABLE subkit.events (
    id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    channel text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE SEQUENCE subkit.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE subkit.events_id_seq OWNED BY subkit.events.id;
--> statement-breakpoint
CREATE TABLE subkit.execution_fixtures (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connector_id uuid,
    endpoint_key text,
    request jsonb,
    response jsonb,
    kind text DEFAULT 'fixture'::text NOT NULL,
    execution_id uuid,
    step_id uuid,
    body jsonb,
    byte_size integer,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.execution_steps (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    step_key text NOT NULL,
    step_index integer,
    kind text NOT NULL,
    status text NOT NULL,
    input_preview jsonb,
    output_preview jsonb,
    result_storage_uri text,
    result_preview text,
    request_meta jsonb,
    duration_ms integer,
    retry_count integer DEFAULT 0 NOT NULL,
    error jsonb,
    placeholders_used jsonb DEFAULT '[]'::jsonb NOT NULL,
    redacted_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    result_sha256 text,
    held boolean DEFAULT false NOT NULL,
    credential_snapshots jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT execution_steps_credential_snapshots_array CHECK ((jsonb_typeof(credential_snapshots) = 'array'::text))
);
--> statement-breakpoint
CREATE TABLE subkit.executions (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_id uuid,
    workflow_version_id uuid,
    source_kind text DEFAULT 'saved'::text NOT NULL,
    source_ref jsonb,
    input jsonb,
    status subkit.execution_status NOT NULL,
    request_source text NOT NULL,
    execution_mode subkit.execution_mode NOT NULL,
    parent_execution_id uuid,
    result_storage_uri text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    abort_requested_at timestamp with time zone,
    result_sha256 text,
    idempotency_key text,
    execution_authority_id uuid,
    hold_writes boolean DEFAULT false NOT NULL,
    tool_approval_id uuid,
    tool_approval_dispatches jsonb DEFAULT '{}'::jsonb NOT NULL,
    authority_root_execution_id uuid,
    authority_call_path jsonb,
    failure jsonb,
    output_contract text,
    caller_context jsonb,
    authorization_context jsonb,
    sensitive_result jsonb,
    caller_origin text DEFAULT 'unknown'::text NOT NULL,
    guard_bucket text,
    guard_unit_key text,
    origin_source text,
    audit_trace_id text,
    result_markdown text,
    result_markdown_truncated boolean DEFAULT false NOT NULL,
    budget_park jsonb,
    CONSTRAINT executions_authority_link_shape_check CHECK ((((authority_root_execution_id IS NULL) = (authority_call_path IS NULL)) AND ((authority_root_execution_id IS NULL) OR ((execution_authority_id IS NULL) AND (tool_approval_id IS NULL) AND (NOT hold_writes) AND (source_kind = 'saved'::text) AND (workflow_id IS NOT NULL) AND (workflow_version_id IS NOT NULL) AND (NOT (parent_execution_id IS DISTINCT FROM authority_root_execution_id)) AND (jsonb_typeof(authority_call_path) = 'array'::text) AND (jsonb_array_length(authority_call_path) >= 1))))),
    CONSTRAINT executions_authority_saved_check CHECK (((execution_authority_id IS NULL) OR ((source_kind = 'saved'::text) AND (workflow_id IS NOT NULL) AND (workflow_version_id IS NOT NULL)))),
    CONSTRAINT executions_caller_origin_check CHECK ((caller_origin = ANY (ARRAY['principal'::text, 'trusted_system'::text, 'unknown'::text]))),
    CONSTRAINT executions_tool_approval_shape_check CHECK (((tool_approval_id IS NULL) OR ((source_kind = 'saved'::text) AND (workflow_id IS NOT NULL) AND (workflow_version_id IS NOT NULL) AND (execution_authority_id IS NULL) AND (NOT hold_writes))))
);
--> statement-breakpoint
CREATE TABLE subkit.external_call_metering (
    id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    provider text NOT NULL,
    operation text,
    units integer DEFAULT 0 NOT NULL,
    cost_usd numeric(12,6),
    latency_ms integer DEFAULT 0 NOT NULL,
    result text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    month_bucket bigint NOT NULL,
    execution_id uuid,
    conversation_id uuid,
    CONSTRAINT external_call_metering_provider_slug_check CHECK ((provider ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT external_call_metering_result_check CHECK ((result = ANY (ARRAY['ok'::text, 'error'::text])))
);
--> statement-breakpoint
CREATE SEQUENCE subkit.external_call_metering_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE subkit.external_call_metering_id_seq OWNED BY subkit.external_call_metering.id;
--> statement-breakpoint
CREATE TABLE subkit.file_links (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    file_id uuid NOT NULL,
    resource_type subkit.file_link_resource NOT NULL,
    resource_id uuid NOT NULL,
    slug text,
    role text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.file_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    file_id uuid NOT NULL,
    version integer NOT NULL,
    filename text NOT NULL,
    content_type text,
    size_bytes bigint NOT NULL,
    storage_uri text NOT NULL,
    sha256 text,
    restored_from integer,
    uploaded_at timestamp with time zone NOT NULL,
    uploaded_by_kind subkit.audit_actor_kind,
    uploaded_by uuid,
    replaced_at timestamp with time zone NOT NULL,
    replaced_by_kind subkit.audit_actor_kind,
    replaced_by uuid,
    CONSTRAINT file_versions_size_bytes_nonnegative CHECK ((size_bytes >= 0))
);
--> statement-breakpoint
CREATE TABLE subkit.files (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    status subkit.file_status DEFAULT 'pending'::subkit.file_status NOT NULL,
    filename text NOT NULL,
    content_type text,
    size_bytes bigint DEFAULT 0 NOT NULL,
    storage_uri text NOT NULL,
    sha256 text,
    upload_url_expires_at timestamp with time zone,
    scan_result text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    slug text,
    replaced_at timestamp with time zone,
    description text,
    category text DEFAULT 'other'::text NOT NULL,
    description_source text DEFAULT 'llm'::text NOT NULL,
    category_source text DEFAULT 'llm'::text NOT NULL,
    catalog_input_hash text,
    catalog_described_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    restored_from integer,
    CONSTRAINT files_catalog_sources CHECK (((description_source = ANY (ARRAY['human'::text, 'llm'::text])) AND (category_source = ANY (ARRAY['human'::text, 'llm'::text])))),
    CONSTRAINT files_category_format CHECK (((category ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (length(category) <= 40)))
);
--> statement-breakpoint
CREATE TABLE subkit.files_dedup_seen (
    tenant_id uuid NOT NULL,
    count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.group_members (
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.group_role_assignments (
    group_id uuid NOT NULL,
    role_id uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.groups (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.hosted_storage_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    storage_key text NOT NULL,
    storage_namespace text NOT NULL,
    declared_bytes bigint NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    absence_verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_storage_objects_absence_check CHECK (((state = 'absence_verified'::text) = (absence_verified_at IS NOT NULL))),
    CONSTRAINT hosted_storage_objects_key_check CHECK ((storage_key ~~ (('offload/'::text || (tenant_id)::text) || '/%'::text))),
    CONSTRAINT hosted_storage_objects_namespace_check CHECK ((storage_namespace ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT hosted_storage_objects_size_check CHECK ((declared_bytes > 0)),
    CONSTRAINT hosted_storage_objects_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'retained'::text, 'deleting'::text, 'absence_verified'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.hosted_tenant_usage (
    tenant_id uuid NOT NULL,
    logical_bytes bigint DEFAULT 0 NOT NULL,
    resource_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_tenant_usage_bytes_check CHECK ((logical_bytes >= 0))
);
--> statement-breakpoint
CREATE TABLE subkit.hosted_work_admissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    state text NOT NULL,
    queue_name text,
    job_id uuid,
    owner_boot_id uuid NOT NULL,
    evidence_sha256 text,
    released_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_work_admissions_job_check CHECK ((((queue_name IS NULL) = (job_id IS NULL)) AND ((state <> 'pending'::text) OR (job_id IS NOT NULL)))),
    CONSTRAINT hosted_work_admissions_kind_check CHECK ((kind = ANY (ARRAY['execution'::text, 'chat'::text]))),
    CONSTRAINT hosted_work_admissions_release_check CHECK (((state = 'released'::text) = (released_at IS NOT NULL))),
    CONSTRAINT hosted_work_admissions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'reconciliation_required'::text, 'released'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.http_rate_limit_buckets (
    bucket_key text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    hits integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT http_rate_limit_buckets_hits_check CHECK ((hits > 0))
);
--> statement-breakpoint
CREATE TABLE subkit.identity_recovery_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    auth_identity_id uuid NOT NULL,
    token_sha256 text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.intake_category_defaults (
    tenant_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid NOT NULL,
    category text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT intake_category_defaults_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'system_account'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.intake_item_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    item_id uuid NOT NULL,
    agent text NOT NULL,
    session_id text NOT NULL,
    repo text,
    excerpt text NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    recorded_by_type text NOT NULL,
    recorded_by_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT intake_item_evidence_recorded_by_type_check CHECK ((recorded_by_type = ANY (ARRAY['user'::text, 'system_account'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.intake_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    client_request_id uuid NOT NULL,
    original_snapshot jsonb NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    state subkit.intake_item_state DEFAULT 'collected'::subkit.intake_item_state NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    collected_by_type text NOT NULL,
    collected_by_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    creation_request_digest text NOT NULL,
    category text NOT NULL,
    admitted_target_kind text,
    admitted_target_id uuid,
    attachment_file_id uuid,
    CONSTRAINT intake_items_admitted_target_check CHECK ((((admitted_target_kind IS NULL) AND (admitted_target_id IS NULL)) OR ((admitted_target_kind = ANY (ARRAY['knowledge'::text, 'skill'::text])) AND (admitted_target_id IS NOT NULL)))),
    CONSTRAINT intake_items_collected_by_type_check CHECK ((collected_by_type = ANY (ARRAY['user'::text, 'system_account'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.intake_proposal_items (
    tenant_id uuid NOT NULL,
    proposal_revision_id uuid NOT NULL,
    item_id uuid NOT NULL,
    item_version integer NOT NULL,
    source_title text NOT NULL,
    source_url text
);
--> statement-breakpoint
CREATE TABLE subkit.intake_proposal_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    revision integer NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    target jsonb NOT NULL,
    digest text NOT NULL,
    created_by_type text NOT NULL,
    created_by_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT intake_proposal_revisions_created_by_type_check CHECK ((created_by_type = ANY (ARRAY['user'::text, 'system_account'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.intake_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    status subkit.intake_proposal_status DEFAULT 'draft'::subkit.intake_proposal_status NOT NULL,
    current_revision integer DEFAULT 1 NOT NULL,
    confirmed_revision integer,
    rejected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stale_reason text,
    confirmed_target_kind text,
    confirmed_target_id uuid,
    CONSTRAINT intake_proposals_confirmed_target_check CHECK ((((confirmed_target_kind IS NULL) AND (confirmed_target_id IS NULL)) OR ((confirmed_target_kind = ANY (ARRAY['knowledge'::text, 'skill'::text])) AND (confirmed_target_id IS NOT NULL))))
);
--> statement-breakpoint
CREATE TABLE subkit.knowledge_chunks (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    knowledge_source_id uuid NOT NULL,
    ordinal integer NOT NULL,
    title text,
    path text,
    content text NOT NULL,
    byte_size integer NOT NULL,
    fingerprint text NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || content))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding real[],
    embedding_model text
);
--> statement-breakpoint
CREATE TABLE subkit.knowledge_source_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    knowledge_source_id uuid NOT NULL,
    version integer NOT NULL,
    content jsonb NOT NULL,
    content_hash text NOT NULL,
    author_user_id uuid,
    author_system_account_id uuid,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.knowledge_sources (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    scope subkit.knowledge_source_scope DEFAULT 'global'::subkit.knowledge_source_scope NOT NULL,
    workflow_id uuid,
    status subkit.knowledge_source_status DEFAULT 'active'::subkit.knowledge_source_status NOT NULL,
    last_error text,
    source_type text NOT NULL,
    source_uri text NOT NULL,
    file_id uuid,
    mime_type text,
    version text NOT NULL,
    bytes_total integer DEFAULT 0 NOT NULL,
    chunk_count integer DEFAULT 0 NOT NULL,
    refresh_strategy subkit.knowledge_source_refresh DEFAULT 'manual'::subkit.knowledge_source_refresh NOT NULL,
    refresh_cron text,
    refresh_webhook_secret text,
    last_refreshed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    category text DEFAULT 'other'::text NOT NULL,
    description_source text DEFAULT 'llm'::text NOT NULL,
    category_source text DEFAULT 'llm'::text NOT NULL,
    catalog_input_hash text,
    catalog_described_at timestamp with time zone,
    CONSTRAINT knowledge_sources_catalog_sources CHECK (((description_source = ANY (ARRAY['human'::text, 'llm'::text])) AND (category_source = ANY (ARRAY['human'::text, 'llm'::text])))),
    CONSTRAINT knowledge_sources_category_format CHECK (((category ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (length(category) <= 40)))
);
--> statement-breakpoint
CREATE TABLE subkit.llm_usage (
    id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    flow text NOT NULL,
    model text NOT NULL,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    total_tokens integer DEFAULT 0 NOT NULL,
    cache_read_tokens integer DEFAULT 0 NOT NULL,
    cache_creation_tokens integer DEFAULT 0 NOT NULL,
    latency_ms integer DEFAULT 0 NOT NULL,
    result text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    month_bucket bigint NOT NULL,
    user_id uuid,
    actor_type text DEFAULT 'system'::text NOT NULL,
    execution_id uuid,
    conversation_id uuid
);
--> statement-breakpoint
CREATE SEQUENCE subkit.llm_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE subkit.llm_usage_id_seq OWNED BY subkit.llm_usage.id;
--> statement-breakpoint
CREATE TABLE subkit.mcp_oauth_access_tokens (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    client_id text NOT NULL,
    user_id uuid NOT NULL,
    prefix text NOT NULL,
    token_sha256 text NOT NULL,
    scope text NOT NULL,
    resource text,
    refresh_token_id uuid,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    grant_id uuid
);
--> statement-breakpoint
CREATE TABLE subkit.mcp_oauth_authorization_codes (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    client_id text NOT NULL,
    user_id uuid NOT NULL,
    code_sha256 text NOT NULL,
    code_challenge text NOT NULL,
    code_challenge_method text NOT NULL,
    redirect_uri text NOT NULL,
    scope text NOT NULL,
    resource text,
    state text,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_oauth_authorization_codes_code_challenge_method_check CHECK ((code_challenge_method = 'S256'::text))
);
--> statement-breakpoint
CREATE TABLE subkit.mcp_oauth_clients (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    client_id text NOT NULL,
    redirect_uris jsonb DEFAULT '[]'::jsonb NOT NULL,
    grant_types jsonb DEFAULT '["authorization_code", "refresh_token"]'::jsonb NOT NULL,
    token_endpoint_auth_method text DEFAULT 'none'::text NOT NULL,
    scope text DEFAULT 'mcp:read'::text NOT NULL,
    client_name text,
    software_id text,
    registration_source text DEFAULT 'dcr'::text NOT NULL,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    client_uri text,
    retired_at timestamp with time zone,
    CONSTRAINT mcp_oauth_clients_registration_source_check CHECK ((registration_source = ANY (ARRAY['dcr'::text, 'manual'::text]))),
    CONSTRAINT mcp_oauth_clients_token_endpoint_auth_method_check CHECK ((token_endpoint_auth_method = 'none'::text))
);
--> statement-breakpoint
CREATE TABLE subkit.mcp_oauth_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    client_id text NOT NULL,
    user_id uuid NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE subkit.mcp_oauth_refresh_tokens (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    client_id text NOT NULL,
    user_id uuid NOT NULL,
    prefix text NOT NULL,
    token_sha256 text NOT NULL,
    scope text NOT NULL,
    rotated_to_id uuid,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resource text,
    grant_id uuid
);
--> statement-breakpoint
CREATE TABLE subkit.mcp_oauth_states (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connector_id uuid CONSTRAINT mcp_oauth_states_mcp_server_id_not_null NOT NULL,
    state text NOT NULL,
    code_verifier text DEFAULT ''::text NOT NULL,
    redirect_uri text NOT NULL,
    authorization_url text,
    as_issuer text,
    requested_scopes text,
    started_by_actor_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text,
    started_by_actor_type text
);
--> statement-breakpoint
CREATE TABLE subkit.mcp_oauth_unknown_grants (
    tenant_id uuid NOT NULL,
    client_id text NOT NULL,
    unknown_since timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.mcp_tasks (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    turn_seq integer NOT NULL,
    kind text NOT NULL,
    job_id text,
    request_source text,
    actor_id uuid,
    user_message_id uuid,
    result jsonb,
    failure_reason text,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    phase text,
    last_action text,
    progress_step text,
    heartbeat_at timestamp with time zone,
    parked_until timestamp with time zone,
    parked_reason text,
    actor_kind subkit.audit_actor_kind,
    origin_source text,
    audit_trace_id text,
    CONSTRAINT mcp_tasks_actor_kind_check CHECK ((((actor_id IS NULL) = (actor_kind IS NULL)) AND ((actor_kind IS NULL) OR (actor_kind <> 'system'::subkit.audit_actor_kind)))),
    CONSTRAINT mcp_tasks_kind_check CHECK ((kind = ANY (ARRAY['start'::text, 'append'::text, 'respond_elicitation'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.notification_channels (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id text NOT NULL,
    channel_id text NOT NULL,
    platform text NOT NULL,
    default_severity text DEFAULT 'info'::text NOT NULL,
    rate_limit_per_minute integer DEFAULT 60 NOT NULL,
    circuit_state text DEFAULT 'closed'::text NOT NULL,
    circuit_open_until timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.notification_deliveries (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    rule_id uuid,
    channel_id uuid,
    event_type text NOT NULL,
    event_payload jsonb,
    severity text NOT NULL,
    status text NOT NULL,
    reason text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.notification_rules (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    event_pattern text NOT NULL,
    workflow_pattern text DEFAULT '*'::text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    request_source_filter jsonb,
    target_workspace_id text NOT NULL,
    target_channel_id text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.oidc_login_states (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid,
    state text NOT NULL,
    code_verifier text NOT NULL,
    nonce text NOT NULL,
    redirect_to text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    membership_invite_id uuid,
    installation_id uuid
);
--> statement-breakpoint
CREATE TABLE subkit.outbound_connection_starts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    state_sha256 text NOT NULL,
    code_verifier text NOT NULL,
    redirect_uri text NOT NULL,
    connection_id uuid,
    name text NOT NULL,
    base_url text NOT NULL,
    issuer text NOT NULL,
    authorization_endpoint text NOT NULL,
    token_endpoint text NOT NULL,
    registration_endpoint text,
    client_id text NOT NULL,
    scopes jsonb NOT NULL,
    service_name text,
    service_description text,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_type text DEFAULT 'unknown'::text NOT NULL,
    actor_id uuid,
    owner_user_id uuid,
    CONSTRAINT outbound_connection_starts_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'system_account'::text, 'unknown'::text]))),
    CONSTRAINT outbound_connection_starts_unknown_actor_id_check CHECK (((actor_type <> 'unknown'::text) OR (actor_id IS NULL)))
);
--> statement-breakpoint
CREATE TABLE subkit.outbound_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    base_url text NOT NULL,
    issuer text NOT NULL,
    authorization_endpoint text NOT NULL,
    token_endpoint text NOT NULL,
    registration_endpoint text,
    client_id text NOT NULL,
    scopes jsonb NOT NULL,
    granted_scopes jsonb,
    service_name text,
    service_description text,
    access_token_version integer NOT NULL,
    refresh_token_version integer,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    last_refreshed_at timestamp with time zone,
    refresh_failed_at timestamp with time zone,
    last_error text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    authority_revision integer DEFAULT 1 NOT NULL,
    verified_identity jsonb,
    CONSTRAINT outbound_connections_authority_revision_positive CHECK ((authority_revision > 0))
);
--> statement-breakpoint
CREATE TABLE subkit.outbox_cursors (
    listener_id text NOT NULL,
    channel text NOT NULL,
    last_seen_id bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.package_install_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    install_id uuid NOT NULL,
    kind text NOT NULL,
    item_key text NOT NULL,
    local_id uuid,
    imported_hash text NOT NULL,
    local_hash text,
    state text NOT NULL,
    intake_proposal_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.package_installs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    package_id text NOT NULL,
    package_version text NOT NULL,
    format text NOT NULL,
    content_digest text NOT NULL,
    archive_file_id uuid,
    source jsonb DEFAULT '{}'::jsonb NOT NULL,
    installed_by_type text NOT NULL,
    installed_by_id uuid,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.patch_candidates (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    connector_id uuid,
    endpoint_key text,
    diff jsonb NOT NULL,
    classification subkit.patch_classification NOT NULL,
    fixture_id uuid,
    status subkit.patch_status NOT NULL,
    outcome_window_ended_at timestamp with time zone,
    outcome_successes_after integer DEFAULT 0 NOT NULL,
    outcome_failures_after integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_reason text,
    closed_against_version_id uuid,
    closed_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE subkit.permissions (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    resource_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.portal_tokens (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    enduser_ref text NOT NULL,
    prefix text NOT NULL,
    token_sha256 text NOT NULL,
    allowed_workflows jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.product_identity_tombstones (
    tenant_id uuid NOT NULL,
    provider_id text NOT NULL,
    issuer_url text NOT NULL,
    subject_sha256 text NOT NULL,
    erased_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.request_hooks (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    role text NOT NULL,
    source text NOT NULL,
    description text,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    stdlib_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.resource_grants (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    granted_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE subkit.risk_signal_edges (
    kind text NOT NULL,
    active boolean NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.role_permissions (
    role_id uuid NOT NULL,
    permission_id uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.roles (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid,
    name text NOT NULL,
    description text,
    is_builtin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT roles_reserved_name_builtin_only CHECK ((is_builtin OR (name <> ALL (ARRAY['admin'::text, 'member'::text, 'enduser'::text, 'metrics_scraper'::text, 'portal_token_user'::text]))))
);
--> statement-breakpoint
CREATE TABLE subkit.runtime_config_replicas (
    instance_id text NOT NULL,
    product_version text NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    active_revision bigint,
    desired_revision bigint,
    ack_revision bigint,
    ack_digest text,
    ack_status subkit.runtime_config_replica_ack_status DEFAULT 'idle'::subkit.runtime_config_replica_ack_status NOT NULL,
    ack_reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.runtime_config_revisions (
    revision bigint NOT NULL,
    document jsonb NOT NULL,
    digest text NOT NULL,
    status subkit.runtime_config_revision_status DEFAULT 'saved'::subkit.runtime_config_revision_status NOT NULL,
    pending_restart_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    failure_reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone
);
--> statement-breakpoint
CREATE SEQUENCE subkit.runtime_config_revisions_revision_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE subkit.runtime_config_revisions_revision_seq OWNED BY subkit.runtime_config_revisions.revision;
--> statement-breakpoint
CREATE TABLE subkit.runtime_config_state (
    key text NOT NULL,
    active_revision bigint,
    desired_revision bigint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    master_key_epoch bigint DEFAULT 0 NOT NULL,
    master_key_digest text,
    vault_maintenance_binding jsonb,
    vault_maintenance_context jsonb,
    CONSTRAINT runtime_master_key_digest_valid CHECK (((master_key_digest IS NULL) OR (master_key_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT runtime_master_key_epoch_valid CHECK (((master_key_epoch >= 0) AND (master_key_epoch <= '9007199254740991'::bigint)))
);
--> statement-breakpoint
CREATE TABLE subkit.runtime_secret_versions (
    name text NOT NULL,
    version integer NOT NULL,
    ciphertext bytea NOT NULL,
    iv bytea NOT NULL,
    auth_tag bytea NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    pending_since timestamp with time zone,
    prepared_by text,
    pending_bindings jsonb,
    tenant_id uuid
);
--> statement-breakpoint
CREATE TABLE subkit.schedule_occurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_id uuid,
    task_id uuid,
    schedule_id uuid,
    due_at timestamp with time zone NOT NULL,
    last_due_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    state text NOT NULL,
    reason_code text,
    skipped_count integer DEFAULT 0 NOT NULL,
    execution_id uuid,
    task_run_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT schedule_occurrences_reason_check CHECK (((reason_code IS NULL) OR (reason_code ~ '^[a-z][a-z0-9_]{0,99}$'::text))),
    CONSTRAINT schedule_occurrences_run_check CHECK (((state = ANY (ARRAY['ran'::text, 'ran_late'::text])) = (started_at IS NOT NULL))),
    CONSTRAINT schedule_occurrences_state_check CHECK ((state = ANY (ARRAY['ran'::text, 'ran_late'::text, 'skipped'::text, 'held'::text]))),
    CONSTRAINT schedule_occurrences_subject_check CHECK (((workflow_id IS NULL) <> (task_id IS NULL))),
    CONSTRAINT schedule_occurrences_window_check CHECK (((last_due_at >= due_at) AND ((skipped_count >= 0) AND (skipped_count <= 100000))))
);
--> statement-breakpoint
CREATE TABLE subkit.scheduler_sweep_cursors (
    producer public.scheduler_sweep_producer NOT NULL,
    epoch bigint DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    after_id uuid,
    epoch_upper_id uuid,
    epoch_cutoff_at timestamp(3) with time zone,
    lease_owner_boot_id uuid,
    lease_token uuid,
    lease_until timestamp(3) with time zone,
    updated_at timestamp(3) with time zone DEFAULT date_trunc('milliseconds'::text, clock_timestamp()) NOT NULL,
    CONSTRAINT scheduler_sweep_epoch_safe CHECK (((epoch >= 0) AND (epoch <= '9007199254740991'::bigint))),
    CONSTRAINT scheduler_sweep_lease_bound CHECK (((lease_until IS NULL) OR ((lease_until > updated_at) AND (lease_until <= (updated_at + '00:01:00'::interval))))),
    CONSTRAINT scheduler_sweep_lease_shape CHECK ((((lease_owner_boot_id IS NULL) AND (lease_token IS NULL) AND (lease_until IS NULL)) OR ((lease_owner_boot_id IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_until IS NOT NULL)))),
    CONSTRAINT scheduler_sweep_position_shape CHECK ((((after_id IS NULL) AND (epoch_upper_id IS NULL) AND (epoch_cutoff_at IS NULL) AND (lease_owner_boot_id IS NULL) AND (lease_token IS NULL) AND (lease_until IS NULL)) OR ((epoch > 0) AND (epoch_upper_id IS NOT NULL) AND (epoch_cutoff_at IS NOT NULL) AND ((after_id IS NULL) OR (after_id <= epoch_upper_id))))),
    CONSTRAINT scheduler_sweep_revision_safe CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint)))
);
--> statement-breakpoint
CREATE TABLE subkit.schema_versions (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    connector_id uuid NOT NULL,
    endpoint_key text NOT NULL,
    schema jsonb NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL,
    workflow_id uuid,
    step_id text,
    observed_schema jsonb
);
--> statement-breakpoint
CREATE TABLE subkit.self_healing_scans (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    source text NOT NULL,
    filters jsonb NOT NULL,
    actor_id uuid,
    idempotency_key text,
    signals_detected integer DEFAULT 0 NOT NULL,
    candidates_created integer DEFAULT 0 NOT NULL,
    unanchored_detected integer DEFAULT 0 NOT NULL,
    duration_ms integer,
    status text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.sessions (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    absolute_expires_at timestamp with time zone,
    token_sha256 text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    product_id text,
    auth_identity_id uuid,
    installation_id uuid
);
--> statement-breakpoint
CREATE TABLE subkit.skill_candidate_evidence (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    skill_candidate_id uuid NOT NULL,
    execution_id uuid,
    patch_candidate_id uuid,
    evidence_type text NOT NULL,
    summary text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.skill_candidates (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    scope subkit.skill_scope NOT NULL,
    connector_id uuid,
    endpoint_key text,
    workflow_id uuid,
    pattern_kind subkit.skill_candidate_pattern NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    examples jsonb,
    evidence jsonb NOT NULL,
    confidence subkit.skill_candidate_confidence NOT NULL,
    status subkit.skill_candidate_status DEFAULT 'proposed'::subkit.skill_candidate_status NOT NULL,
    promoted_skill_id uuid,
    fingerprint text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    proposed_by_user_id uuid,
    proposed_by_system_account_id uuid
);
--> statement-breakpoint
CREATE TABLE subkit.skill_effectiveness (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    skill_id uuid NOT NULL,
    skill_candidate_id uuid,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    executions_before integer NOT NULL,
    failures_before integer NOT NULL,
    executions_after integer NOT NULL,
    failures_after integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    intake_proposal_id uuid,
    CONSTRAINT skill_effectiveness_origin_check CHECK (((skill_candidate_id IS NULL) <> (intake_proposal_id IS NULL)))
);
--> statement-breakpoint
CREATE TABLE subkit.skills (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    scope subkit.skill_scope NOT NULL,
    connector_id uuid,
    workflow_id uuid,
    title text NOT NULL,
    body text NOT NULL,
    examples jsonb,
    arguments jsonb,
    lifecycle subkit.skill_lifecycle NOT NULL,
    source subkit.skill_source DEFAULT 'manual'::subkit.skill_source NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    seed_source text,
    slug text,
    gates_tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    activates_when jsonb DEFAULT '[]'::jsonb NOT NULL,
    input_schema jsonb,
    output_schema jsonb,
    side_effects text DEFAULT 'read'::text NOT NULL,
    idempotency text DEFAULT 'none'::text NOT NULL,
    maturity text DEFAULT 'stable'::text NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    applies_to text DEFAULT 'both'::text NOT NULL,
    description text,
    category text DEFAULT 'other'::text NOT NULL,
    description_source text DEFAULT 'llm'::text NOT NULL,
    category_source text DEFAULT 'llm'::text NOT NULL,
    catalog_input_hash text,
    catalog_described_at timestamp with time zone,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    domains jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT skills_applies_to_chk CHECK ((applies_to = ANY (ARRAY['chat'::text, 'authoring'::text, 'both'::text]))),
    CONSTRAINT skills_catalog_sources CHECK (((description_source = ANY (ARRAY['human'::text, 'llm'::text])) AND (category_source = ANY (ARRAY['human'::text, 'llm'::text])))),
    CONSTRAINT skills_category_format CHECK (((category ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (length(category) <= 40))),
    CONSTRAINT skills_domains_array_chk CHECK ((jsonb_typeof(domains) = 'array'::text)),
    CONSTRAINT skills_idempotency_chk CHECK ((idempotency = ANY (ARRAY['none'::text, 'naturally'::text, 'key_required'::text]))),
    CONSTRAINT skills_maturity_chk CHECK ((maturity = ANY (ARRAY['experimental'::text, 'stable'::text]))),
    CONSTRAINT skills_rules_array_chk CHECK ((jsonb_typeof(rules) = 'array'::text)),
    CONSTRAINT skills_side_effects_chk CHECK ((side_effects = ANY (ARRAY['none'::text, 'read'::text, 'write'::text, 'destructive'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.subscriptions (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    event_pattern text NOT NULL,
    target_url text NOT NULL,
    secret_ciphertext bytea NOT NULL,
    secret_iv bytea NOT NULL,
    secret_auth_tag bytea NOT NULL,
    rotating_secret_ciphertext bytea,
    rotating_secret_iv bytea,
    rotating_secret_auth_tag bytea,
    filters jsonb,
    active boolean DEFAULT true NOT NULL,
    circuit_open_until timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.system_accounts (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    role_id uuid,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.task_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    task_id uuid NOT NULL,
    fingerprint text NOT NULL,
    environment subkit.execution_mode NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone,
    max_runs integer,
    reserved_runs integer DEFAULT 0 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    workflow_authority_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    expiry_notified_at timestamp with time zone,
    CONSTRAINT task_grants_authorities_check CHECK (((jsonb_typeof(workflow_authority_ids) = 'array'::text) AND (jsonb_array_length(workflow_authority_ids) <= 200) AND (octet_length((workflow_authority_ids)::text) <= 8192))),
    CONSTRAINT task_grants_fingerprint_check CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT task_grants_revocation_check CHECK (((revoked_at IS NULL) = (revoked_by IS NULL))),
    CONSTRAINT task_grants_run_limit_check CHECK (((reserved_runs >= 0) AND ((max_runs IS NULL) OR ((max_runs > 0) AND (reserved_runs <= max_runs))))),
    CONSTRAINT task_grants_window_check CHECK (((valid_until IS NULL) OR (valid_until > valid_from)))
);
--> statement-breakpoint
CREATE TABLE subkit.task_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    task_id uuid NOT NULL,
    task_revision integer NOT NULL,
    fingerprint text NOT NULL,
    conversation_id uuid,
    trigger text NOT NULL,
    started_by uuid,
    grant_id uuid,
    state text NOT NULL,
    waiting_reason text,
    next_check_at timestamp with time zone,
    sleep_reason text,
    deadline_at timestamp with time zone NOT NULL,
    turns_used integer DEFAULT 0 NOT NULL,
    no_progress_count integer DEFAULT 0 NOT NULL,
    last_seen_turn_id uuid,
    last_seen_turn_seq integer DEFAULT 0 NOT NULL,
    turn_job_failures integer DEFAULT 0 NOT NULL,
    budget_wait_tokens integer,
    rejected_playbook_revision integer,
    last_playbook_revision integer DEFAULT 0 NOT NULL,
    trace_id text NOT NULL,
    failure_code text,
    result_ready_at timestamp with time zone,
    completed_at timestamp with time zone,
    completed_by uuid,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    progress_marks jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT task_runs_counters_check CHECK (((task_revision >= 1) AND (turns_used >= 0) AND (no_progress_count >= 0) AND (last_playbook_revision >= 0))),
    CONSTRAINT task_runs_failure_code_check CHECK (((failure_code IS NULL) OR (char_length(failure_code) <= 200))),
    CONSTRAINT task_runs_fingerprint_check CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT task_runs_progress_marks_check CHECK ((jsonb_typeof(progress_marks) = 'array'::text)),
    CONSTRAINT task_runs_sleep_reason_check CHECK (((sleep_reason IS NULL) OR (char_length(sleep_reason) <= 200))),
    CONSTRAINT task_runs_state_check CHECK ((state = ANY (ARRAY['running'::text, 'waiting'::text, 'sleeping'::text, 'result_ready'::text, 'completed'::text, 'aborted'::text, 'failed'::text]))),
    CONSTRAINT task_runs_trace_id_check CHECK ((trace_id ~ '^[0-9a-f]{32}$'::text)),
    CONSTRAINT task_runs_trigger_check CHECK ((trigger = ANY (ARRAY['manual'::text, 'once'::text, 'cron'::text]))),
    CONSTRAINT task_runs_waiting_reason_check CHECK (((waiting_reason IS NULL) OR (waiting_reason = ANY (ARRAY['question'::text, 'approval'::text, 'no_progress'::text, 'budget'::text, 'question_expired'::text, 'ai_access'::text, 'turn_stopped'::text]))))
);
--> statement-breakpoint
CREATE TABLE subkit.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    category text DEFAULT 'other'::text NOT NULL,
    description_source text DEFAULT 'llm'::text NOT NULL,
    category_source text DEFAULT 'llm'::text NOT NULL,
    catalog_input_hash text,
    catalog_described_at timestamp with time zone,
    owner_id uuid NOT NULL,
    goal text NOT NULL,
    done_when text NOT NULL,
    plan jsonb NOT NULL,
    bindings jsonb NOT NULL,
    environment subkit.execution_mode NOT NULL,
    schedule_cron text,
    schedule_timezone text,
    schedule_run_at timestamp with time zone,
    last_claimed_at timestamp with time zone,
    admission_hold_reason text,
    admission_hold_since timestamp with time zone,
    schedule_anchor_at timestamp with time zone DEFAULT now() NOT NULL,
    paused_at timestamp with time zone,
    paused_by uuid,
    paused_reason text,
    max_turns integer DEFAULT 20 NOT NULL,
    run_deadline_minutes integer DEFAULT 240 NOT NULL,
    fingerprint text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    lifecycle text DEFAULT 'active'::text NOT NULL,
    locale text DEFAULT 'de'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    goal_edited_by uuid,
    CONSTRAINT tasks_admission_hold_check CHECK ((((admission_hold_reason IS NULL) AND (admission_hold_since IS NULL)) OR ((admission_hold_since IS NOT NULL) AND (admission_hold_reason = ANY (ARRAY['grant_required'::text, 'grant_expired'::text, 'grant_exhausted'::text, 'grant_fingerprint_mismatch'::text, 'owner_unavailable'::text, 'ai_access_missing'::text, 'previous_run_active'::text, 'paused'::text]))))),
    CONSTRAINT tasks_catalog_sources CHECK (((description_source = ANY (ARRAY['human'::text, 'llm'::text])) AND (category_source = ANY (ARRAY['human'::text, 'llm'::text])))),
    CONSTRAINT tasks_category_format CHECK (((category ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (length(category) <= 40))),
    CONSTRAINT tasks_documents_check CHECK (((jsonb_typeof(plan) = 'object'::text) AND (jsonb_typeof(bindings) = 'object'::text))),
    CONSTRAINT tasks_fingerprint_check CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tasks_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT tasks_limits_check CHECK (((max_turns >= 1) AND (run_deadline_minutes >= 1))),
    CONSTRAINT tasks_locale_check CHECK ((locale = ANY (ARRAY['de'::text, 'en'::text]))),
    CONSTRAINT tasks_paused_check CHECK ((((paused_at IS NULL) AND (paused_by IS NULL) AND (paused_reason IS NULL)) OR ((paused_at IS NOT NULL) AND (paused_reason = ANY (ARRAY['owner_request'::text, 'admin'::text, 'owner_unavailable'::text]))))),
    CONSTRAINT tasks_revision_check CHECK ((revision >= 1)),
    CONSTRAINT tasks_schedule_check CHECK (((schedule_cron IS NULL) OR (schedule_run_at IS NULL)))
);
--> statement-breakpoint
CREATE TABLE subkit.tenant_branding (
    tenant_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    display_name text,
    subtitle text,
    palette public.tenant_branding_palette,
    logo_light bytea,
    logo_dark bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    app_icon_192 bytea,
    app_icon_512 bytea,
    CONSTRAINT tenant_branding_display_name_check CHECK (((display_name IS NULL) OR (char_length(display_name) <= 80))),
    CONSTRAINT tenant_branding_revision_check CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT tenant_branding_subtitle_check CHECK (((subtitle IS NULL) OR (char_length(subtitle) <= 160)))
);
--> statement-breakpoint
CREATE TABLE subkit.tenant_erasure_states (
    tenant_id uuid NOT NULL,
    stage text DEFAULT 'claimed'::text NOT NULL,
    lease_owner uuid,
    lease_expires_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    failure_code text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    drain_boot_id text,
    drain_untracked boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.tenant_skill_overrides (
    tenant_id uuid NOT NULL,
    skill_slug text NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    body_override text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.tenants (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    llm_primary text,
    llm_fallback text,
    egress_guard_mode subkit.egress_guard_mode,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    last_proactive_scan_at timestamp with time zone,
    last_skill_candidate_analyze_at timestamp with time zone,
    last_connector_reauth_scan_at timestamp with time zone,
    last_endpoint_contract_scan_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_operator boolean DEFAULT false NOT NULL,
    origin public.tenant_origin DEFAULT 'self_hosted'::public.tenant_origin NOT NULL,
    status public.tenant_status DEFAULT 'active'::public.tenant_status NOT NULL,
    owner_identity_id uuid,
    deletion_requested_at timestamp with time zone,
    deletion_scheduled_for timestamp with time zone,
    workflow_approval_policy text DEFAULT 'single'::text NOT NULL,
    workflow_approval_policy_changed_at timestamp with time zone,
    workflow_approval_policy_changed_by uuid,
    spend_limit_usd numeric(12,2) DEFAULT 50 NOT NULL,
    spend_continue_month text,
    spend_limit_chosen_at timestamp with time zone DEFAULT now(),
    spend_limit_changed_by uuid,
    CONSTRAINT tenants_deletion_schedule_check CHECK ((((status <> 'pending_deletion'::public.tenant_status) AND (deletion_requested_at IS NULL) AND (deletion_scheduled_for IS NULL)) OR ((status = 'pending_deletion'::public.tenant_status) AND (origin = 'self_service'::public.tenant_origin) AND (deletion_requested_at IS NOT NULL) AND (deletion_scheduled_for IS NOT NULL) AND (deletion_requested_at < deletion_scheduled_for)))),
    CONSTRAINT tenants_origin_owner_check CHECK ((((origin = 'self_hosted'::public.tenant_origin) AND (owner_identity_id IS NULL)) OR ((origin = 'self_service'::public.tenant_origin) AND (owner_identity_id IS NOT NULL) AND (NOT is_operator)))),
    CONSTRAINT tenants_workflow_approval_policy_check CHECK ((workflow_approval_policy = ANY (ARRAY['single'::text, 'pair'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.tool_approval_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    tool text NOT NULL,
    scope_hash text NOT NULL,
    scope jsonb NOT NULL,
    state text DEFAULT 'observed'::text NOT NULL,
    approvals_count integer DEFAULT 1 NOT NULL,
    use_count integer DEFAULT 0 NOT NULL,
    offered_at timestamp with time zone,
    decided_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    content_class text DEFAULT 'no_content'::text NOT NULL,
    content_hash text,
    expires_at timestamp with time zone,
    daily_limit integer DEFAULT 20 NOT NULL,
    uses_day date,
    uses_on_day integer DEFAULT 0 NOT NULL,
    CONSTRAINT tool_approval_rules_content_class_check CHECK ((content_class = ANY (ARRAY['no_content'::text, 'same_content'::text, 'person_given'::text]))),
    CONSTRAINT tool_approval_rules_content_hash_check CHECK (((content_hash IS NULL) OR (content_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT tool_approval_rules_counters_check CHECK (((approvals_count >= 1) AND (use_count >= 0))),
    CONSTRAINT tool_approval_rules_daily_check CHECK ((((daily_limit >= 1) AND (daily_limit <= 500)) AND (uses_on_day >= 0))),
    CONSTRAINT tool_approval_rules_revocation_check CHECK (((state = 'revoked'::text) = (revoked_at IS NOT NULL))),
    CONSTRAINT tool_approval_rules_scope_check CHECK (((jsonb_typeof(scope) = 'object'::text) AND (octet_length((scope)::text) <= 4096))),
    CONSTRAINT tool_approval_rules_scope_hash_check CHECK ((scope_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tool_approval_rules_state_check CHECK ((state = ANY (ARRAY['observed'::text, 'offered'::text, 'active'::text, 'dismissed'::text, 'revoked'::text]))),
    CONSTRAINT tool_approval_rules_tool_check CHECK (((char_length(tool) >= 1) AND (char_length(tool) <= 200)))
);
--> statement-breakpoint
CREATE TABLE subkit.tool_approvals (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    tool text NOT NULL,
    surface text NOT NULL,
    execution_mode text,
    args_ciphertext bytea NOT NULL,
    args_iv bytea NOT NULL,
    args_auth_tag bytea NOT NULL,
    args_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    granted_at timestamp with time zone,
    granted_by_user_id uuid,
    granted_via text,
    declined_at timestamp with time zone,
    consumed_at timestamp with time zone,
    preview_ciphertext bytea,
    preview_iv bytea,
    preview_auth_tag bytea,
    portal_token_sha256 text,
    claimed_execution_id uuid,
    caller_context jsonb,
    authorization_context jsonb
);
--> statement-breakpoint
CREATE TABLE subkit.transactional_mail_receipts (
    tenant_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    request_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    step_id text NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.usage_events (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    surface text NOT NULL,
    operation text NOT NULL,
    method text,
    outcome text NOT NULL,
    traffic_class text DEFAULT 'organic'::text NOT NULL,
    request_source text NOT NULL,
    actor_hmac text,
    session_hmac text,
    status_code integer,
    duration_ms integer,
    request_bytes integer,
    response_bytes integer,
    stream_outcome text,
    platform text,
    response_mode text,
    task_phase text,
    item_count integer,
    active_sessions integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_events_nonnegative_measurements_check CHECK (((COALESCE(duration_ms, 0) >= 0) AND (COALESCE(request_bytes, 0) >= 0) AND (COALESCE(response_bytes, 0) >= 0) AND (COALESCE(item_count, 0) >= 0) AND (COALESCE(active_sessions, 0) >= 0))),
    CONSTRAINT usage_events_surface_check CHECK ((surface = ANY (ARRAY['http'::text, 'chat'::text, 'mcp'::text, 'conversations'::text]))),
    CONSTRAINT usage_events_traffic_class_check CHECK ((traffic_class = ANY (ARRAY['organic'::text, 'synthetic'::text, 'internal'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.user_identities (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider_id text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    issuer_url text,
    product_id text
);
--> statement-breakpoint
CREATE TABLE subkit.user_invites (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    prefix text NOT NULL,
    token_sha256 text NOT NULL,
    scopes jsonb NOT NULL,
    allowed_workflows jsonb,
    allowed_connectors jsonb,
    expires_at timestamp with time zone NOT NULL,
    redeemed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.user_llm_settings (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.user_setup_preferences (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    default_environment text,
    approver_kind text,
    approver_email text,
    approver_user_id uuid,
    approver_invite_id uuid,
    notification_schedule jsonb,
    first_job text,
    services jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    timezone text,
    critical_breakthrough boolean DEFAULT false NOT NULL,
    last_digest_at timestamp with time zone,
    notifications_paused_at timestamp with time zone,
    notifications_paused_until timestamp with time zone,
    ask_before_writing boolean DEFAULT false NOT NULL,
    CONSTRAINT user_setup_preferences_approver_check CHECK ((((approver_kind IS NULL) AND (approver_email IS NULL) AND (approver_user_id IS NULL) AND (approver_invite_id IS NULL)) OR ((approver_kind = 'self'::text) AND (approver_email IS NULL) AND (approver_user_id IS NULL) AND (approver_invite_id IS NULL)) OR ((approver_kind = ANY (ARRAY['teammate'::text, 'pair'::text])) AND ((char_length(approver_email) >= 3) AND (char_length(approver_email) <= 254))))),
    CONSTRAINT user_setup_preferences_environment_check CHECK (((default_environment IS NULL) OR (default_environment = ANY (ARRAY['dev'::text, 'prod'::text])))),
    CONSTRAINT user_setup_preferences_first_job_check CHECK (((first_job IS NULL) OR ((char_length(first_job) >= 1) AND (char_length(first_job) <= 120)))),
    CONSTRAINT user_setup_preferences_pause_check CHECK (((notifications_paused_until IS NULL) OR ((notifications_paused_at IS NOT NULL) AND (notifications_paused_until > notifications_paused_at)))),
    CONSTRAINT user_setup_preferences_schedule_check CHECK (((notification_schedule IS NULL) OR ((jsonb_typeof(notification_schedule) = 'object'::text) AND (octet_length((notification_schedule)::text) <= 256)))),
    CONSTRAINT user_setup_preferences_services_check CHECK (((jsonb_typeof(services) = 'array'::text) AND (jsonb_array_length(services) <= 50) AND (octet_length((services)::text) <= 4096))),
    CONSTRAINT user_setup_preferences_timezone_check CHECK (((timezone IS NULL) OR ((char_length(timezone) >= 1) AND (char_length(timezone) <= 64))))
);
--> statement-breakpoint
CREATE TABLE subkit.users (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    email text NOT NULL,
    role_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status subkit.user_status DEFAULT 'active'::subkit.user_status NOT NULL,
    display_name text,
    auth_identity_id uuid,
    start_steps_hidden_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE subkit.vault_items (
    id uuid DEFAULT public.gen_random_uuid() CONSTRAINT credentials_id_not_null NOT NULL,
    tenant_id uuid CONSTRAINT credentials_tenant_id_not_null NOT NULL,
    connector_id uuid,
    environment subkit.environment CONSTRAINT credentials_environment_not_null NOT NULL,
    mode subkit.credential_mode CONSTRAINT credentials_mode_not_null NOT NULL,
    ciphertext bytea CONSTRAINT credentials_ciphertext_not_null NOT NULL,
    iv bytea CONSTRAINT credentials_iv_not_null NOT NULL,
    auth_tag bytea CONSTRAINT credentials_auth_tag_not_null NOT NULL,
    oauth2_refresh_ciphertext bytea,
    oauth2_refresh_iv bytea,
    oauth2_refresh_auth_tag bytea,
    oauth2_expires_at timestamp with time zone,
    granted_scopes text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT credentials_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT credentials_updated_at_not_null NOT NULL,
    connection_id uuid,
    authority_revision integer DEFAULT 1 CONSTRAINT credentials_authority_revision_not_null NOT NULL,
    verified_identity jsonb,
    credential_generation integer DEFAULT 1 CONSTRAINT credentials_credential_generation_not_null NOT NULL,
    kind text DEFAULT 'connector'::text NOT NULL,
    name text NOT NULL,
    description text,
    owner_user_id uuid,
    template_slug text,
    created_by uuid,
    rotated_at timestamp with time zone,
    last_used_at timestamp with time zone,
    CONSTRAINT vault_items_authority_revision_positive CHECK ((authority_revision > 0)),
    CONSTRAINT vault_items_connector_kind_check CHECK (((kind = 'connector'::text) = (connector_id IS NOT NULL))),
    CONSTRAINT vault_items_credential_generation_positive CHECK ((credential_generation > 0)),
    CONSTRAINT vault_items_kind_check CHECK ((kind = ANY (ARRAY['connector'::text, 'secret'::text, 'login'::text, 'template_client'::text]))),
    CONSTRAINT vault_items_name_check CHECK ((name ~ '^[a-z0-9][a-z0-9_-]{0,62}$'::text)),
    CONSTRAINT vault_items_template_kind_check CHECK (((kind = 'template_client'::text) = (template_slug IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE subkit.vendor_recipe_overrides (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    client text NOT NULL,
    override jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.webhook_replay_seen (
    tenant_id uuid NOT NULL,
    webhook_id uuid NOT NULL,
    standard_webhook_id text NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.webhooks_inbound (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    slug text NOT NULL,
    workflow_id uuid NOT NULL,
    verifier text NOT NULL,
    native_verifier_config jsonb,
    secret_ciphertext bytea NOT NULL,
    secret_iv bytea NOT NULL,
    secret_auth_tag bytea NOT NULL,
    active boolean DEFAULT true NOT NULL,
    origin text DEFAULT 'crud'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    admission_hold jsonb
);
--> statement-breakpoint
CREATE TABLE subkit.webhooks_outbound (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subscription_id uuid,
    signing_keys jsonb NOT NULL,
    circuit_state text DEFAULT 'closed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.workflow_authority_pair_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    execution_environment text NOT NULL,
    expected_manifest_digest text CONSTRAINT workflow_authority_pair_reque_expected_manifest_digest_not_null NOT NULL,
    "grant" jsonb NOT NULL,
    first_approver_id uuid NOT NULL,
    second_approver_id uuid,
    state text DEFAULT 'pending'::text NOT NULL,
    stale_reason text,
    expires_at timestamp with time zone NOT NULL,
    decided_at timestamp with time zone,
    authority_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_authority_pair_requests_approved_check CHECK (((state = 'approved'::text) = ((authority_id IS NOT NULL) AND (second_approver_id IS NOT NULL)))),
    CONSTRAINT workflow_authority_pair_requests_digest_check CHECK ((expected_manifest_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT workflow_authority_pair_requests_environment_check CHECK ((execution_environment = ANY (ARRAY['dev'::text, 'prod'::text]))),
    CONSTRAINT workflow_authority_pair_requests_grant_check CHECK (((jsonb_typeof("grant") = 'object'::text) AND (octet_length(("grant")::text) <= 4096))),
    CONSTRAINT workflow_authority_pair_requests_stale_check CHECK (((state = 'stale'::text) = (stale_reason IS NOT NULL))),
    CONSTRAINT workflow_authority_pair_requests_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'withdrawn'::text, 'expired'::text, 'stale'::text]))),
    CONSTRAINT workflow_authority_pair_requests_two_people_check CHECK (((second_approver_id IS NULL) OR (second_approver_id <> first_approver_id)))
);
--> statement-breakpoint
CREATE TABLE subkit.workflow_autoheal_policies (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    policy subkit.autoheal_policy DEFAULT 'safe-patches'::subkit.autoheal_policy NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.workflow_execution_authorities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    effect_manifest_digest text NOT NULL,
    effect_manifest jsonb NOT NULL,
    execution_environment subkit.execution_mode NOT NULL,
    target_constraints jsonb NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone,
    max_runs integer,
    reserved_runs integer DEFAULT 0 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    inherited_from uuid,
    superseded_by uuid,
    approved_manifest jsonb,
    expiry_notified_at timestamp with time zone,
    CONSTRAINT workflow_authorities_digest_check CHECK ((effect_manifest_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_authorities_manifest_check CHECK ((jsonb_typeof(effect_manifest) = 'object'::text)),
    CONSTRAINT workflow_authorities_revocation_check CHECK ((((revoked_at IS NULL) AND (revoked_by IS NULL) AND (superseded_by IS NULL)) OR ((revoked_at IS NOT NULL) AND ((revoked_by IS NOT NULL) OR (superseded_by IS NOT NULL))))),
    CONSTRAINT workflow_authorities_run_limit_check CHECK (((reserved_runs >= 0) AND ((max_runs IS NULL) OR ((max_runs > 0) AND (reserved_runs <= max_runs))))),
    CONSTRAINT workflow_authorities_targets_check CHECK (((jsonb_typeof(target_constraints) = 'object'::text) AND (target_constraints ? 'targets'::text) AND (jsonb_typeof((target_constraints -> 'targets'::text)) = 'array'::text))),
    CONSTRAINT workflow_authorities_window_check CHECK (((valid_until IS NULL) OR (valid_until > valid_from)))
);
--> statement-breakpoint
CREATE TABLE subkit.workflow_review_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_id uuid,
    conversation_id uuid NOT NULL,
    prepared_by uuid NOT NULL,
    session_id uuid NOT NULL,
    snapshot jsonb NOT NULL,
    snapshot_digest text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    authority_id uuid,
    schedule_id uuid,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_review_receipts_completion_check CHECK ((((status = 'pending'::text) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (completed_at IS NOT NULL)))),
    CONSTRAINT workflow_review_receipts_digest_check CHECK ((snapshot_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_review_receipts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text])))
);
--> statement-breakpoint
CREATE TABLE subkit.workflow_run_state (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    key text NOT NULL,
    ciphertext bytea NOT NULL,
    iv bytea NOT NULL,
    auth_tag bytea NOT NULL,
    value_kind text,
    note jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.workflow_signals (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    event_name text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.workflow_versions (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    version integer NOT NULL,
    dag jsonb NOT NULL,
    author_user_id uuid,
    author_system_account_id uuid,
    note text,
    scope_index jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    authority_growth jsonb,
    spec jsonb
);
--> statement-breakpoint
CREATE TABLE subkit.workflow_waits (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    step_id text NOT NULL,
    sleep_until_ts timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE subkit.workflows (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    current_version_id uuid,
    lifecycle subkit.workflow_lifecycle NOT NULL,
    is_tool boolean DEFAULT true NOT NULL,
    last_executed_at timestamp with time zone,
    health_state text DEFAULT 'ok'::text NOT NULL,
    health_reason text,
    health_changed_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    draft_version_id uuid,
    category text DEFAULT 'other'::text NOT NULL,
    description_source text DEFAULT 'llm'::text NOT NULL,
    category_source text DEFAULT 'llm'::text NOT NULL,
    catalog_input_hash text,
    catalog_described_at timestamp with time zone,
    CONSTRAINT workflows_catalog_sources CHECK (((description_source = ANY (ARRAY['human'::text, 'llm'::text])) AND (category_source = ANY (ARRAY['human'::text, 'llm'::text])))),
    CONSTRAINT workflows_category_format CHECK (((category ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (length(category) <= 40)))
);
--> statement-breakpoint
CREATE TABLE subkit.workflows_schedules (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    cron text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    input jsonb,
    last_enqueued_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    execution_mode subkit.execution_mode DEFAULT 'prod'::subkit.execution_mode NOT NULL,
    admission_hold jsonb,
    input_error jsonb,
    paused_at timestamp with time zone,
    paused_reason text,
    paused_failure_class text,
    paused_failure_count integer,
    failures_reset_at timestamp with time zone,
    created_by uuid,
    CONSTRAINT workflows_schedules_auto_pause_check CHECK ((((paused_reason IS NULL) AND (paused_at IS NULL) AND (paused_failure_class IS NULL) AND (paused_failure_count IS NULL)) OR (paused AND (paused_at IS NOT NULL) AND (paused_reason = 'repeated_failures'::text) AND ((char_length(paused_failure_class) >= 1) AND (char_length(paused_failure_class) <= 200)) AND (paused_failure_count >= 1))))
);
--> statement-breakpoint
ALTER TABLE ONLY subkit.cli_notification_inbox ALTER COLUMN id SET DEFAULT nextval('subkit.cli_notification_inbox_id_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY subkit.events ALTER COLUMN id SET DEFAULT nextval('subkit.events_id_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY subkit.external_call_metering ALTER COLUMN id SET DEFAULT nextval('subkit.external_call_metering_id_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY subkit.llm_usage ALTER COLUMN id SET DEFAULT nextval('subkit.llm_usage_id_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY subkit.runtime_config_revisions ALTER COLUMN revision SET DEFAULT nextval('subkit.runtime_config_revisions_revision_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY subkit.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.auth_identities
    ADD CONSTRAINT auth_identities_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.auth_provider_configs
    ADD CONSTRAINT auth_provider_configs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.caller_budget_units
    ADD CONSTRAINT caller_budget_units_pk PRIMARY KEY (tenant_id, bucket, principal_id, unit_key);
--> statement-breakpoint
ALTER TABLE ONLY subkit.catalog_categories
    ADD CONSTRAINT catalog_categories_tenant_id_name_pk PRIMARY KEY (tenant_id, name);
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_composer_attachments
    ADD CONSTRAINT chat_composer_attachments_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_deliveries
    ADD CONSTRAINT chat_deliveries_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_identities
    ADD CONSTRAINT chat_identities_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_sessions
    ADD CONSTRAINT chat_sessions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_workspaces
    ADD CONSTRAINT chat_workspaces_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.cli_notification_inbox
    ADD CONSTRAINT cli_notification_inbox_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.cli_notification_inbox_reads
    ADD CONSTRAINT cli_notification_inbox_reads_inbox_id_user_id_pk PRIMARY KEY (inbox_id, user_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.cockpit_installations
    ADD CONSTRAINT cockpit_installations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.cockpit_push_keys
    ADD CONSTRAINT cockpit_push_keys_pkey PRIMARY KEY (tenant_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.cockpit_push_subscriptions
    ADD CONSTRAINT cockpit_push_subscriptions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_credential_setup_grants
    ADD CONSTRAINT connector_credential_setup_grants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_document_chunks
    ADD CONSTRAINT connector_document_chunks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_documents
    ADD CONSTRAINT connector_documents_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_endpoint_schemas
    ADD CONSTRAINT connector_endpoint_schemas_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_environments
    ADD CONSTRAINT connector_environments_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_mcp_sessions
    ADD CONSTRAINT connector_mcp_sessions_pkey PRIMARY KEY (connector_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_oauth_start_grants
    ADD CONSTRAINT connector_oauth_start_grants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_oauth_states
    ADD CONSTRAINT connector_oauth_states_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_promotions
    ADD CONSTRAINT connector_promotions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_templates
    ADD CONSTRAINT connector_templates_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.connectors
    ADD CONSTRAINT connectors_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_draft_snapshots
    ADD CONSTRAINT conversation_draft_snapshots_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_drafts
    ADD CONSTRAINT conversation_drafts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_elicitations
    ADD CONSTRAINT conversation_elicitations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_hidden
    ADD CONSTRAINT conversation_hidden_conversation_id_user_id_pk PRIMARY KEY (conversation_id, user_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_messages
    ADD CONSTRAINT conversation_messages_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_tool_calls
    ADD CONSTRAINT conversation_tool_calls_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_turns
    ADD CONSTRAINT conversation_turns_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.data_migrations
    ADD CONSTRAINT data_migrations_pkey PRIMARY KEY (name);
--> statement-breakpoint
ALTER TABLE ONLY subkit.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.desktop_login_codes
    ADD CONSTRAINT desktop_login_codes_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_allowances
    ADD CONSTRAINT device_allowances_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_commands
    ADD CONSTRAINT device_commands_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_runner_nonces
    ADD CONSTRAINT device_runner_nonces_device_runner_id_nonce_pk PRIMARY KEY (device_runner_id, nonce);
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_runners
    ADD CONSTRAINT device_runners_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_upload_chunks
    ADD CONSTRAINT device_upload_chunks_upload_id_n_pk PRIMARY KEY (upload_id, n);
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_uploads
    ADD CONSTRAINT device_uploads_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_waits
    ADD CONSTRAINT device_waits_pkey PRIMARY KEY (execution_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.discovery_artifacts
    ADD CONSTRAINT discovery_artifacts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.discovery_files
    ADD CONSTRAINT discovery_files_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.discovery_runs
    ADD CONSTRAINT discovery_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.engine_restart_requests
    ADD CONSTRAINT engine_restart_requests_pkey PRIMARY KEY (key);
--> statement-breakpoint
ALTER TABLE ONLY subkit.engine_settings
    ADD CONSTRAINT engine_settings_pkey PRIMARY KEY (key);
--> statement-breakpoint
ALTER TABLE ONLY subkit.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.execution_fixtures
    ADD CONSTRAINT execution_fixtures_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.execution_steps
    ADD CONSTRAINT execution_steps_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.executions
    ADD CONSTRAINT executions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.external_call_metering
    ADD CONSTRAINT external_call_metering_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.file_links
    ADD CONSTRAINT file_links_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.file_versions
    ADD CONSTRAINT file_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.files_dedup_seen
    ADD CONSTRAINT files_dedup_seen_pkey PRIMARY KEY (tenant_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.group_members
    ADD CONSTRAINT group_members_group_id_user_id_pk PRIMARY KEY (group_id, user_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.group_role_assignments
    ADD CONSTRAINT group_role_assignments_group_id_role_id_pk PRIMARY KEY (group_id, role_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.hosted_storage_objects
    ADD CONSTRAINT hosted_storage_objects_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.hosted_tenant_usage
    ADD CONSTRAINT hosted_tenant_usage_pkey PRIMARY KEY (tenant_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.hosted_work_admissions
    ADD CONSTRAINT hosted_work_admissions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.http_rate_limit_buckets
    ADD CONSTRAINT http_rate_limit_buckets_bucket_key_window_started_at_pk PRIMARY KEY (bucket_key, window_started_at);
--> statement-breakpoint
ALTER TABLE ONLY subkit.identity_recovery_sessions
    ADD CONSTRAINT identity_recovery_sessions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_item_evidence
    ADD CONSTRAINT intake_item_evidence_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_items
    ADD CONSTRAINT intake_items_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_items
    ADD CONSTRAINT intake_items_tenant_id_key UNIQUE (tenant_id, id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposal_revisions
    ADD CONSTRAINT intake_proposal_revisions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposal_revisions
    ADD CONSTRAINT intake_proposal_revisions_tenant_id_key UNIQUE (tenant_id, id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposals
    ADD CONSTRAINT intake_proposals_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposals
    ADD CONSTRAINT intake_proposals_tenant_id_key UNIQUE (tenant_id, id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.knowledge_source_versions
    ADD CONSTRAINT knowledge_source_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.knowledge_sources
    ADD CONSTRAINT knowledge_sources_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.llm_usage
    ADD CONSTRAINT llm_usage_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_access_tokens
    ADD CONSTRAINT mcp_oauth_access_tokens_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_authorization_codes
    ADD CONSTRAINT mcp_oauth_authorization_codes_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_clients
    ADD CONSTRAINT mcp_oauth_clients_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_grants
    ADD CONSTRAINT mcp_oauth_grants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_refresh_tokens
    ADD CONSTRAINT mcp_oauth_refresh_tokens_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_states
    ADD CONSTRAINT mcp_oauth_states_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_tasks
    ADD CONSTRAINT mcp_tasks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.notification_channels
    ADD CONSTRAINT notification_channels_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.notification_rules
    ADD CONSTRAINT notification_rules_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.oidc_login_states
    ADD CONSTRAINT oidc_login_states_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.outbound_connection_starts
    ADD CONSTRAINT outbound_connection_starts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.outbound_connections
    ADD CONSTRAINT outbound_connections_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.outbox_cursors
    ADD CONSTRAINT outbox_cursors_listener_id_channel_pk PRIMARY KEY (listener_id, channel);
--> statement-breakpoint
ALTER TABLE ONLY subkit.package_install_items
    ADD CONSTRAINT package_install_items_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.package_installs
    ADD CONSTRAINT package_installs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.patch_candidates
    ADD CONSTRAINT patch_candidates_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.portal_tokens
    ADD CONSTRAINT portal_tokens_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.request_hooks
    ADD CONSTRAINT request_hooks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.resource_grants
    ADD CONSTRAINT resource_grants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.risk_signal_edges
    ADD CONSTRAINT risk_signal_edges_pkey PRIMARY KEY (kind);
--> statement-breakpoint
ALTER TABLE ONLY subkit.role_permissions
    ADD CONSTRAINT role_permissions_role_id_permission_id_pk PRIMARY KEY (role_id, permission_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.runtime_config_replicas
    ADD CONSTRAINT runtime_config_replicas_pkey PRIMARY KEY (instance_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.runtime_config_revisions
    ADD CONSTRAINT runtime_config_revisions_pkey PRIMARY KEY (revision);
--> statement-breakpoint
ALTER TABLE ONLY subkit.runtime_config_state
    ADD CONSTRAINT runtime_config_state_pkey PRIMARY KEY (key);
--> statement-breakpoint
ALTER TABLE ONLY subkit.runtime_secret_versions
    ADD CONSTRAINT runtime_secret_versions_name_version_pk PRIMARY KEY (name, version);
--> statement-breakpoint
ALTER TABLE ONLY subkit.schedule_occurrences
    ADD CONSTRAINT schedule_occurrences_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.scheduler_sweep_cursors
    ADD CONSTRAINT scheduler_sweep_cursors_pkey PRIMARY KEY (producer);
--> statement-breakpoint
ALTER TABLE ONLY subkit.schema_versions
    ADD CONSTRAINT schema_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.self_healing_scans
    ADD CONSTRAINT self_healing_scans_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.skill_candidate_evidence
    ADD CONSTRAINT skill_candidate_evidence_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.skill_candidates
    ADD CONSTRAINT skill_candidates_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.skill_effectiveness
    ADD CONSTRAINT skill_effectiveness_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.system_accounts
    ADD CONSTRAINT system_accounts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.task_grants
    ADD CONSTRAINT task_grants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.task_runs
    ADD CONSTRAINT task_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.tenant_branding
    ADD CONSTRAINT tenant_branding_pkey PRIMARY KEY (tenant_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.tenant_erasure_states
    ADD CONSTRAINT tenant_erasure_states_pkey PRIMARY KEY (tenant_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.tool_approval_rules
    ADD CONSTRAINT tool_approval_rules_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.tool_approvals
    ADD CONSTRAINT tool_approvals_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.transactional_mail_receipts
    ADD CONSTRAINT transactional_mail_receipts_tenant_id_workflow_id_request_id_pk PRIMARY KEY (tenant_id, workflow_id, request_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.usage_events
    ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_identities
    ADD CONSTRAINT user_identities_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_invites
    ADD CONSTRAINT user_invites_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_llm_settings
    ADD CONSTRAINT user_llm_settings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_setup_preferences
    ADD CONSTRAINT user_setup_preferences_tenant_id_user_id_pk PRIMARY KEY (tenant_id, user_id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.vault_items
    ADD CONSTRAINT vault_items_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.vendor_recipe_overrides
    ADD CONSTRAINT vendor_recipe_overrides_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.webhooks_inbound
    ADD CONSTRAINT webhooks_inbound_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.webhooks_outbound
    ADD CONSTRAINT webhooks_outbound_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_authority_pair_requests
    ADD CONSTRAINT workflow_authority_pair_requests_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_autoheal_policies
    ADD CONSTRAINT workflow_autoheal_policies_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_execution_authorities
    ADD CONSTRAINT workflow_execution_authorities_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_review_receipts
    ADD CONSTRAINT workflow_review_receipts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_run_state
    ADD CONSTRAINT workflow_run_state_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_signals
    ADD CONSTRAINT workflow_signals_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_versions
    ADD CONSTRAINT workflow_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_waits
    ADD CONSTRAINT workflow_waits_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflows_schedules
    ADD CONSTRAINT workflows_schedules_pkey PRIMARY KEY (id);
--> statement-breakpoint
CREATE UNIQUE INDEX api_keys_prefix_key ON subkit.api_keys USING btree (prefix);
--> statement-breakpoint
CREATE INDEX api_keys_rotating_out_at_idx ON subkit.api_keys USING btree (rotating_out_at);
--> statement-breakpoint
CREATE INDEX api_keys_tenant_revoked_idx ON subkit.api_keys USING btree (tenant_id, revoked_at);
--> statement-breakpoint
CREATE INDEX audit_log_tenant_action_ts_idx ON subkit.audit_log USING btree (tenant_id, action, ts);
--> statement-breakpoint
CREATE INDEX audit_log_tenant_ts_idx ON subkit.audit_log USING btree (tenant_id, ts);
--> statement-breakpoint
CREATE UNIQUE INDEX auth_identities_issuer_subject_key ON subkit.auth_identities USING btree (issuer_url, subject);
--> statement-breakpoint
CREATE INDEX auth_provider_configs_tenant_priority_idx ON subkit.auth_provider_configs USING btree (tenant_id, priority);
--> statement-breakpoint
CREATE INDEX caller_budget_units_day_idx ON subkit.caller_budget_units USING btree (tenant_id, bucket, principal_id, day) WHERE (state = ANY (ARRAY['reserved'::text, 'committed'::text]));
--> statement-breakpoint
CREATE INDEX chat_composer_attachments_expires_idx ON subkit.chat_composer_attachments USING btree (expires_at);
--> statement-breakpoint
CREATE INDEX chat_composer_attachments_user_created_idx ON subkit.chat_composer_attachments USING btree (tenant_id, user_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX chat_composer_attachments_user_file_key ON subkit.chat_composer_attachments USING btree (tenant_id, user_id, file_id);
--> statement-breakpoint
CREATE INDEX chat_deliveries_workspace_status_created_idx ON subkit.chat_deliveries USING btree (workspace_id, status, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX chat_events_seen_key ON subkit.chat_events_seen USING btree (workspace_id, platform_event_id);
--> statement-breakpoint
CREATE INDEX chat_events_seen_seen_at_idx ON subkit.chat_events_seen USING btree (seen_at);
--> statement-breakpoint
CREATE UNIQUE INDEX chat_identities_platform_workspace_user_key ON subkit.chat_identities USING btree (platform, workspace_id, platform_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX chat_sessions_workspace_thread_key ON subkit.chat_sessions USING btree (workspace_id, thread_id);
--> statement-breakpoint
CREATE UNIQUE INDEX chat_workspaces_platform_workspace_global_key ON subkit.chat_workspaces USING btree (platform, workspace_id);
--> statement-breakpoint
CREATE UNIQUE INDEX chat_workspaces_tenant_platform_workspace_key ON subkit.chat_workspaces USING btree (tenant_id, platform, workspace_id);
--> statement-breakpoint
CREATE INDEX cli_notification_inbox_actionable_idx ON subkit.cli_notification_inbox USING btree (tenant_id, id) WHERE actionable;
--> statement-breakpoint
CREATE INDEX cli_notification_inbox_reads_user_idx ON subkit.cli_notification_inbox_reads USING btree (tenant_id, user_id, inbox_id);
--> statement-breakpoint
CREATE INDEX cli_notification_inbox_tenant_cursor_idx ON subkit.cli_notification_inbox USING btree (tenant_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX cockpit_installations_active_desktop_device_key ON subkit.cockpit_installations USING btree (tenant_id, owner_user_id, device_id) WHERE ((revoked_at IS NULL) AND (kind = 'desktop'::text));
--> statement-breakpoint
CREATE UNIQUE INDEX cockpit_installations_active_tenant_owner_key ON subkit.cockpit_installations USING btree (tenant_id, owner_user_id) WHERE ((revoked_at IS NULL) AND (kind = 'browser'::text));
--> statement-breakpoint
CREATE INDEX cockpit_installations_tenant_owner_idx ON subkit.cockpit_installations USING btree (tenant_id, owner_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX cockpit_push_subscriptions_browser_endpoint_key ON subkit.cockpit_push_subscriptions USING btree (tenant_id, endpoint_sha256) WHERE (kind = 'browser'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX cockpit_push_subscriptions_installation_session_key ON subkit.cockpit_push_subscriptions USING btree (installation_id, session_id);
--> statement-breakpoint
CREATE INDEX cockpit_push_subscriptions_session_idx ON subkit.cockpit_push_subscriptions USING btree (session_id);
--> statement-breakpoint
CREATE INDEX cockpit_push_subscriptions_tenant_installation_idx ON subkit.cockpit_push_subscriptions USING btree (tenant_id, installation_id);
--> statement-breakpoint
CREATE INDEX cockpit_push_subscriptions_tenant_user_idx ON subkit.cockpit_push_subscriptions USING btree (tenant_id, user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX conn_ep_schemas_method_path_uq ON subkit.connector_endpoint_schemas USING btree (connector_id, method, path);
--> statement-breakpoint
CREATE UNIQUE INDEX connector_credential_setup_grants_token_sha256_key ON subkit.connector_credential_setup_grants USING btree (token_sha256);
--> statement-breakpoint
CREATE INDEX connector_document_chunks_tenant_connector_ordinal_idx ON subkit.connector_document_chunks USING btree (tenant_id, connector_id, ordinal);
--> statement-breakpoint
CREATE INDEX connector_document_chunks_tsv_idx ON subkit.connector_document_chunks USING gin (tsv);
--> statement-breakpoint
CREATE INDEX connector_documents_tenant_connector_idx ON subkit.connector_documents USING btree (tenant_id, connector_id);
--> statement-breakpoint
CREATE INDEX connector_endpoint_schemas_tenant_connector_idx ON subkit.connector_endpoint_schemas USING btree (tenant_id, connector_id);
--> statement-breakpoint
CREATE UNIQUE INDEX connector_environments_connector_env_key ON subkit.connector_environments USING btree (connector_id, environment);
--> statement-breakpoint
CREATE INDEX connector_mcp_sessions_tenant_idx ON subkit.connector_mcp_sessions USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX connector_oauth_start_grants_token_sha256_key ON subkit.connector_oauth_start_grants USING btree (token_sha256);
--> statement-breakpoint
CREATE UNIQUE INDEX connector_oauth_states_state_key ON subkit.connector_oauth_states USING btree (state);
--> statement-breakpoint
CREATE INDEX connector_promotions_source_idx ON subkit.connector_promotions USING btree (tenant_id, source_connector_id);
--> statement-breakpoint
CREATE INDEX connector_promotions_target_idx ON subkit.connector_promotions USING btree (tenant_id, target_connector_id);
--> statement-breakpoint
CREATE UNIQUE INDEX connector_promotions_tenant_idempotency_key ON subkit.connector_promotions USING btree (tenant_id, idempotency_key_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX connector_templates_tenant_slug_key ON subkit.connector_templates USING btree (tenant_id, slug);
--> statement-breakpoint
CREATE INDEX connectors_needs_reauth_idx ON subkit.connectors USING btree (tenant_id) WHERE (needs_reauth = true);
--> statement-breakpoint
CREATE INDEX connectors_tenant_category_idx ON subkit.connectors USING btree (tenant_id, category);
--> statement-breakpoint
CREATE UNIQUE INDEX connectors_tenant_slug_env_key ON subkit.connectors USING btree (tenant_id, slug, environment) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX conv_draft_snap_conv_snap_idx ON subkit.conversation_draft_snapshots USING btree (conversation_id, snapshot_at);
--> statement-breakpoint
CREATE INDEX conversation_drafts_conv_ordinal_idx ON subkit.conversation_drafts USING btree (conversation_id, ordinal);
--> statement-breakpoint
CREATE INDEX conversation_elicitations_conv_status_idx ON subkit.conversation_elicitations USING btree (conversation_id, status);
--> statement-breakpoint
CREATE INDEX conversation_elicitations_expiry_sweep_idx ON subkit.conversation_elicitations USING btree (expires_at) WHERE (status = 'pending'::subkit.elicitation_status);
--> statement-breakpoint
CREATE INDEX conversation_elicitations_parent_msg_idx ON subkit.conversation_elicitations USING btree (parent_message_id);
--> statement-breakpoint
CREATE INDEX conversation_hidden_tenant_user_idx ON subkit.conversation_hidden USING btree (tenant_id, user_id);
--> statement-breakpoint
CREATE INDEX conversation_messages_conv_created_idx ON subkit.conversation_messages USING btree (conversation_id, created_at);
--> statement-breakpoint
CREATE INDEX conversation_tool_calls_conv_created_idx ON subkit.conversation_tool_calls USING btree (conversation_id, created_at);
--> statement-breakpoint
CREATE INDEX conversation_tool_calls_parent_msg_idx ON subkit.conversation_tool_calls USING btree (parent_message_id);
--> statement-breakpoint
CREATE UNIQUE INDEX conversation_turns_active_idx ON subkit.conversation_turns USING btree (tenant_id, conversation_id) WHERE (state = ANY (ARRAY['queued'::text, 'running'::text, 'parked'::text]));
--> statement-breakpoint
CREATE INDEX conversation_turns_conversation_idx ON subkit.conversation_turns USING btree (tenant_id, conversation_id, created_at);
--> statement-breakpoint
CREATE INDEX conversations_owner_idx ON subkit.conversations USING btree (tenant_id, owner_id, updated_at);
--> statement-breakpoint
CREATE INDEX conversations_tenant_status_idx ON subkit.conversations USING btree (tenant_id, status);
--> statement-breakpoint
CREATE INDEX deliveries_status_retry_idx ON subkit.deliveries USING btree (status, next_retry_at);
--> statement-breakpoint
CREATE INDEX deliveries_tenant_status_created_idx ON subkit.deliveries USING btree (tenant_id, status, created_at);
--> statement-breakpoint
CREATE INDEX deliveries_tenant_sub_created_idx ON subkit.deliveries USING btree (tenant_id, subscription_id, created_at);
--> statement-breakpoint
CREATE INDEX desktop_login_codes_expires_idx ON subkit.desktop_login_codes USING btree (expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX desktop_login_codes_sha256_key ON subkit.desktop_login_codes USING btree (code_sha256);
--> statement-breakpoint
CREATE INDEX desktop_login_codes_tenant_user_idx ON subkit.desktop_login_codes USING btree (tenant_id, user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX device_allowances_active_item_key ON subkit.device_allowances USING btree (device_runner_id, kind, item_id) WHERE (removed_at IS NULL);
--> statement-breakpoint
CREATE INDEX device_allowances_tenant_runner_idx ON subkit.device_allowances USING btree (tenant_id, device_runner_id);
--> statement-breakpoint
CREATE INDEX device_commands_tenant_device_state_idx ON subkit.device_commands USING btree (tenant_id, device_id, state);
--> statement-breakpoint
CREATE INDEX device_commands_tenant_execution_idx ON subkit.device_commands USING btree (tenant_id, execution_id);
--> statement-breakpoint
CREATE INDEX device_runner_nonces_expiry_idx ON subkit.device_runner_nonces USING btree (tenant_id, device_runner_id, expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX device_runners_active_installation_key ON subkit.device_runners USING btree (tenant_id, installation_id) WHERE (revoked_at IS NULL);
--> statement-breakpoint
CREATE INDEX device_runners_tenant_owner_idx ON subkit.device_runners USING btree (tenant_id, owner_user_id);
--> statement-breakpoint
CREATE INDEX device_upload_chunks_tenant_idx ON subkit.device_upload_chunks USING btree (tenant_id, upload_id);
--> statement-breakpoint
CREATE INDEX device_uploads_tenant_command_idx ON subkit.device_uploads USING btree (tenant_id, command_id);
--> statement-breakpoint
CREATE INDEX device_waits_tenant_device_idx ON subkit.device_waits USING btree (tenant_id, device_id);
--> statement-breakpoint
CREATE INDEX discovery_artifacts_run_kind_idx ON subkit.discovery_artifacts USING btree (run_id, kind);
--> statement-breakpoint
CREATE INDEX discovery_artifacts_tenant_status_idx ON subkit.discovery_artifacts USING btree (tenant_id, status);
--> statement-breakpoint
CREATE INDEX discovery_files_run_idx ON subkit.discovery_files USING btree (run_id);
--> statement-breakpoint
CREATE INDEX discovery_runs_tenant_status_idx ON subkit.discovery_runs USING btree (tenant_id, status);
--> statement-breakpoint
CREATE INDEX events_channel_id_idx ON subkit.events USING btree (channel, id);
--> statement-breakpoint
CREATE INDEX events_tenant_created_idx ON subkit.events USING btree (tenant_id, created_at);
--> statement-breakpoint
CREATE INDEX execution_fixtures_connector_endpoint_idx ON subkit.execution_fixtures USING btree (connector_id, endpoint_key);
--> statement-breakpoint
CREATE INDEX execution_fixtures_execution_idx ON subkit.execution_fixtures USING btree (execution_id);
--> statement-breakpoint
CREATE INDEX execution_fixtures_kind_idx ON subkit.execution_fixtures USING btree (kind);
--> statement-breakpoint
CREATE INDEX execution_steps_execution_started_idx ON subkit.execution_steps USING btree (execution_id, started_at);
--> statement-breakpoint
CREATE INDEX execution_steps_running_execution_idx ON subkit.execution_steps USING btree (execution_id) WHERE (status = 'running'::text);
--> statement-breakpoint
CREATE INDEX executions_active_guard_unit_idx ON subkit.executions USING btree (tenant_id, guard_unit_key) WHERE ((status = ANY (ARRAY['queued'::subkit.execution_status, 'running'::subkit.execution_status])) AND (guard_unit_key IS NOT NULL));
--> statement-breakpoint
CREATE INDEX executions_authority_idx ON subkit.executions USING btree (tenant_id, execution_authority_id);
--> statement-breakpoint
CREATE INDEX executions_authority_link_idx ON subkit.executions USING btree (tenant_id, authority_root_execution_id);
--> statement-breakpoint
CREATE UNIQUE INDEX executions_single_tool_approval_uidx ON subkit.executions USING btree (tool_approval_id) WHERE (tool_approval_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX executions_tenant_idempotency_key_uidx ON subkit.executions USING btree (tenant_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);
--> statement-breakpoint
CREATE INDEX executions_tenant_request_source_idx ON subkit.executions USING btree (tenant_id, request_source);
--> statement-breakpoint
CREATE INDEX executions_tenant_source_kind_idx ON subkit.executions USING btree (tenant_id, source_kind);
--> statement-breakpoint
CREATE INDEX executions_tenant_status_idx ON subkit.executions USING btree (tenant_id, status);
--> statement-breakpoint
CREATE INDEX executions_tenant_status_started_idx ON subkit.executions USING btree (tenant_id, status, started_at);
--> statement-breakpoint
CREATE INDEX executions_tenant_workflow_started_idx ON subkit.executions USING btree (tenant_id, workflow_id, started_at);
--> statement-breakpoint
CREATE INDEX external_call_metering_execution_idx ON subkit.external_call_metering USING btree (tenant_id, execution_id);
--> statement-breakpoint
CREATE INDEX external_call_metering_tenant_created_idx ON subkit.external_call_metering USING btree (tenant_id, created_at);
--> statement-breakpoint
CREATE INDEX external_call_metering_tenant_provider_month_idx ON subkit.external_call_metering USING btree (tenant_id, provider, month_bucket);
--> statement-breakpoint
CREATE UNIQUE INDEX file_links_conv_slug_uq ON subkit.file_links USING btree (tenant_id, resource_type, resource_id, slug);
--> statement-breakpoint
CREATE INDEX file_links_tenant_resource_idx ON subkit.file_links USING btree (tenant_id, resource_type, resource_id);
--> statement-breakpoint
CREATE UNIQUE INDEX file_versions_tenant_file_version_uq ON subkit.file_versions USING btree (tenant_id, file_id, version);
--> statement-breakpoint
CREATE INDEX files_tenant_category_idx ON subkit.files USING btree (tenant_id, category);
--> statement-breakpoint
CREATE UNIQUE INDEX files_tenant_sha256_uq ON subkit.files USING btree (tenant_id, sha256);
--> statement-breakpoint
CREATE UNIQUE INDEX files_tenant_slug_uq ON subkit.files USING btree (tenant_id, slug) WHERE ((slug IS NOT NULL) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE INDEX files_tenant_status_idx ON subkit.files USING btree (tenant_id, status);
--> statement-breakpoint
CREATE INDEX group_members_user_idx ON subkit.group_members USING btree (user_id);
--> statement-breakpoint
CREATE INDEX group_role_assignments_role_idx ON subkit.group_role_assignments USING btree (role_id);
--> statement-breakpoint
CREATE UNIQUE INDEX groups_tenant_name_key ON subkit.groups USING btree (tenant_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX hosted_storage_objects_key ON subkit.hosted_storage_objects USING btree (storage_key);
--> statement-breakpoint
CREATE INDEX hosted_storage_objects_tenant_state_idx ON subkit.hosted_storage_objects USING btree (tenant_id, state);
--> statement-breakpoint
CREATE UNIQUE INDEX hosted_work_admissions_job_key ON subkit.hosted_work_admissions USING btree (tenant_id, queue_name, job_id);
--> statement-breakpoint
CREATE INDEX hosted_work_admissions_tenant_state_idx ON subkit.hosted_work_admissions USING btree (tenant_id, kind, state);
--> statement-breakpoint
CREATE INDEX http_rate_limit_buckets_expiry_idx ON subkit.http_rate_limit_buckets USING btree (expires_at);
--> statement-breakpoint
CREATE INDEX identity_recovery_expiry_idx ON subkit.identity_recovery_sessions USING btree (expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX intake_category_defaults_actor_key ON subkit.intake_category_defaults USING btree (tenant_id, actor_type, actor_id);
--> statement-breakpoint
CREATE INDEX intake_category_defaults_tenant_category_idx ON subkit.intake_category_defaults USING btree (tenant_id, category);
--> statement-breakpoint
CREATE UNIQUE INDEX intake_item_evidence_item_session_key ON subkit.intake_item_evidence USING btree (tenant_id, item_id, session_id);
--> statement-breakpoint
CREATE INDEX intake_item_evidence_tenant_item_created_idx ON subkit.intake_item_evidence USING btree (tenant_id, item_id, created_at);
--> statement-breakpoint
CREATE INDEX intake_items_tenant_category_updated_idx ON subkit.intake_items USING btree (tenant_id, category, updated_at);
--> statement-breakpoint
CREATE UNIQUE INDEX intake_items_tenant_request_key ON subkit.intake_items USING btree (tenant_id, client_request_id);
--> statement-breakpoint
CREATE INDEX intake_items_tenant_state_updated_idx ON subkit.intake_items USING btree (tenant_id, state, updated_at);
--> statement-breakpoint
CREATE UNIQUE INDEX intake_proposal_items_revision_item_key ON subkit.intake_proposal_items USING btree (proposal_revision_id, item_id);
--> statement-breakpoint
CREATE INDEX intake_proposal_items_tenant_item_idx ON subkit.intake_proposal_items USING btree (tenant_id, item_id);
--> statement-breakpoint
CREATE UNIQUE INDEX intake_proposal_revisions_digest_key ON subkit.intake_proposal_revisions USING btree (proposal_id, digest);
--> statement-breakpoint
CREATE UNIQUE INDEX intake_proposal_revisions_revision_key ON subkit.intake_proposal_revisions USING btree (proposal_id, revision);
--> statement-breakpoint
CREATE INDEX intake_proposal_revisions_tenant_proposal_idx ON subkit.intake_proposal_revisions USING btree (tenant_id, proposal_id);
--> statement-breakpoint
CREATE INDEX intake_proposals_tenant_status_updated_idx ON subkit.intake_proposals USING btree (tenant_id, status, updated_at);
--> statement-breakpoint
CREATE INDEX knowledge_chunks_tenant_source_ordinal_idx ON subkit.knowledge_chunks USING btree (tenant_id, knowledge_source_id, ordinal);
--> statement-breakpoint
CREATE INDEX knowledge_chunks_tsv_idx ON subkit.knowledge_chunks USING gin (tsv);
--> statement-breakpoint
CREATE UNIQUE INDEX knowledge_source_versions_source_version_key ON subkit.knowledge_source_versions USING btree (knowledge_source_id, version);
--> statement-breakpoint
CREATE INDEX knowledge_source_versions_tenant_source_idx ON subkit.knowledge_source_versions USING btree (tenant_id, knowledge_source_id);
--> statement-breakpoint
CREATE INDEX knowledge_sources_tenant_category_idx ON subkit.knowledge_sources USING btree (tenant_id, category);
--> statement-breakpoint
CREATE INDEX knowledge_sources_tenant_idx ON subkit.knowledge_sources USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX knowledge_sources_tenant_scope_idx ON subkit.knowledge_sources USING btree (tenant_id, scope);
--> statement-breakpoint
CREATE UNIQUE INDEX knowledge_sources_tenant_slug_key ON subkit.knowledge_sources USING btree (tenant_id, slug) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX knowledge_sources_tenant_tags_idx ON subkit.knowledge_sources USING gin (tags);
--> statement-breakpoint
CREATE INDEX knowledge_sources_tenant_workflow_idx ON subkit.knowledge_sources USING btree (tenant_id, workflow_id);
--> statement-breakpoint
CREATE INDEX llm_usage_conversation_idx ON subkit.llm_usage USING btree (tenant_id, conversation_id);
--> statement-breakpoint
CREATE INDEX llm_usage_execution_idx ON subkit.llm_usage USING btree (tenant_id, execution_id);
--> statement-breakpoint
CREATE INDEX llm_usage_tenant_created_idx ON subkit.llm_usage USING btree (tenant_id, created_at);
--> statement-breakpoint
CREATE INDEX llm_usage_tenant_month_idx ON subkit.llm_usage USING btree (tenant_id, month_bucket);
--> statement-breakpoint
CREATE INDEX llm_usage_tenant_user_created_idx ON subkit.llm_usage USING btree (tenant_id, user_id, created_at);
--> statement-breakpoint
CREATE INDEX llm_usage_tenant_user_month_idx ON subkit.llm_usage USING btree (tenant_id, user_id, month_bucket);
--> statement-breakpoint
CREATE INDEX mcp_oauth_access_tokens_prefix_idx ON subkit.mcp_oauth_access_tokens USING btree (prefix);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_oauth_access_tokens_sha256_key ON subkit.mcp_oauth_access_tokens USING btree (token_sha256);
--> statement-breakpoint
CREATE INDEX mcp_oauth_access_tokens_tenant_idx ON subkit.mcp_oauth_access_tokens USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX mcp_oauth_access_tokens_unknown_grant_idx ON subkit.mcp_oauth_access_tokens USING btree (client_id) WHERE (grant_id IS NULL);
--> statement-breakpoint
CREATE INDEX mcp_oauth_authorization_codes_expires_idx ON subkit.mcp_oauth_authorization_codes USING btree (expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_oauth_authorization_codes_sha256_key ON subkit.mcp_oauth_authorization_codes USING btree (code_sha256);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_oauth_clients_client_id_key ON subkit.mcp_oauth_clients USING btree (client_id);
--> statement-breakpoint
CREATE INDEX mcp_oauth_grants_client_idx ON subkit.mcp_oauth_grants USING btree (client_id);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_oauth_grants_identity_key ON subkit.mcp_oauth_grants USING btree (id, tenant_id, client_id, user_id);
--> statement-breakpoint
CREATE INDEX mcp_oauth_grants_tenant_client_user_idx ON subkit.mcp_oauth_grants USING btree (tenant_id, client_id, user_id);
--> statement-breakpoint
CREATE INDEX mcp_oauth_refresh_tokens_prefix_idx ON subkit.mcp_oauth_refresh_tokens USING btree (prefix);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_oauth_refresh_tokens_sha256_key ON subkit.mcp_oauth_refresh_tokens USING btree (token_sha256);
--> statement-breakpoint
CREATE INDEX mcp_oauth_refresh_tokens_tenant_idx ON subkit.mcp_oauth_refresh_tokens USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX mcp_oauth_refresh_tokens_unknown_grant_idx ON subkit.mcp_oauth_refresh_tokens USING btree (client_id) WHERE (grant_id IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_oauth_states_state_key ON subkit.mcp_oauth_states USING btree (state);
--> statement-breakpoint
CREATE INDEX mcp_oauth_states_tenant_server_idx ON subkit.mcp_oauth_states USING btree (tenant_id, connector_id);
--> statement-breakpoint
CREATE INDEX mcp_oauth_unknown_grants_client_idx ON subkit.mcp_oauth_unknown_grants USING btree (client_id);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_oauth_unknown_grants_tenant_client_key ON subkit.mcp_oauth_unknown_grants USING btree (tenant_id, client_id);
--> statement-breakpoint
CREATE INDEX mcp_tasks_conv_turn_idx ON subkit.mcp_tasks USING btree (tenant_id, conversation_id, turn_seq);
--> statement-breakpoint
CREATE INDEX mcp_tasks_tenant_created_idx ON subkit.mcp_tasks USING btree (tenant_id, created_at);
--> statement-breakpoint
CREATE INDEX notification_channels_tenant_ws_channel_idx ON subkit.notification_channels USING btree (tenant_id, workspace_id, channel_id);
--> statement-breakpoint
CREATE INDEX notification_deliveries_tenant_status_idx ON subkit.notification_deliveries USING btree (tenant_id, status, created_at);
--> statement-breakpoint
CREATE INDEX notification_rules_tenant_event_idx ON subkit.notification_rules USING btree (tenant_id, event_pattern);
--> statement-breakpoint
CREATE INDEX notification_rules_tenant_target_idx ON subkit.notification_rules USING btree (tenant_id, target_workspace_id, target_channel_id);
--> statement-breakpoint
CREATE INDEX oidc_login_states_expires_idx ON subkit.oidc_login_states USING btree (expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX oidc_login_states_state_key ON subkit.oidc_login_states USING btree (state);
--> statement-breakpoint
CREATE UNIQUE INDEX outbound_connection_starts_state_key ON subkit.outbound_connection_starts USING btree (state_sha256);
--> statement-breakpoint
CREATE INDEX outbound_connections_expires_idx ON subkit.outbound_connections USING btree (expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX outbound_connections_tenant_name_key ON subkit.outbound_connections USING btree (tenant_id, name);
--> statement-breakpoint
CREATE INDEX package_install_items_install_idx ON subkit.package_install_items USING btree (tenant_id, install_id);
--> statement-breakpoint
CREATE UNIQUE INDEX package_install_items_tenant_item_key ON subkit.package_install_items USING btree (tenant_id, kind, item_key);
--> statement-breakpoint
CREATE INDEX package_installs_tenant_package_idx ON subkit.package_installs USING btree (tenant_id, package_id);
--> statement-breakpoint
CREATE INDEX patch_candidates_endpoint_idx ON subkit.patch_candidates USING btree (tenant_id, workflow_id, connector_id, endpoint_key, status);
--> statement-breakpoint
CREATE INDEX patch_candidates_tenant_status_created_idx ON subkit.patch_candidates USING btree (tenant_id, status, created_at);
--> statement-breakpoint
CREATE INDEX patch_candidates_tenant_workflow_status_idx ON subkit.patch_candidates USING btree (tenant_id, workflow_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX permissions_name_key ON subkit.permissions USING btree (name);
--> statement-breakpoint
CREATE UNIQUE INDEX portal_tokens_prefix_key ON subkit.portal_tokens USING btree (prefix);
--> statement-breakpoint
CREATE INDEX portal_tokens_tenant_enduser_idx ON subkit.portal_tokens USING btree (tenant_id, enduser_ref);
--> statement-breakpoint
CREATE UNIQUE INDEX product_identity_tombstones_subject_key ON subkit.product_identity_tombstones USING btree (tenant_id, provider_id, subject_sha256);
--> statement-breakpoint
CREATE INDEX request_hooks_tenant_role_version_idx ON subkit.request_hooks USING btree (tenant_id, role, version);
--> statement-breakpoint
CREATE INDEX resource_grants_resource_idx ON subkit.resource_grants USING btree (tenant_id, resource_type, resource_id);
--> statement-breakpoint
CREATE INDEX resource_grants_subject_idx ON subkit.resource_grants USING btree (tenant_id, subject_type, subject_id);
--> statement-breakpoint
CREATE UNIQUE INDEX resource_grants_unique_key ON subkit.resource_grants USING btree (tenant_id, subject_type, subject_id, resource_type, resource_id, permission_id);
--> statement-breakpoint
CREATE INDEX role_permissions_permission_idx ON subkit.role_permissions USING btree (permission_id);
--> statement-breakpoint
CREATE INDEX role_permissions_role_idx ON subkit.role_permissions USING btree (role_id);
--> statement-breakpoint
CREATE UNIQUE INDEX roles_tenant_name_key ON subkit.roles USING btree (tenant_id, name);
--> statement-breakpoint
CREATE INDEX runtime_config_replicas_lease_idx ON subkit.runtime_config_replicas USING btree (last_seen_at);
--> statement-breakpoint
CREATE INDEX runtime_config_revisions_digest_idx ON subkit.runtime_config_revisions USING btree (digest);
--> statement-breakpoint
CREATE INDEX runtime_secret_versions_name_idx ON subkit.runtime_secret_versions USING btree (name);
--> statement-breakpoint
CREATE INDEX schedule_occurrences_retention_idx ON subkit.schedule_occurrences USING btree (created_at);
--> statement-breakpoint
CREATE INDEX schedule_occurrences_task_idx ON subkit.schedule_occurrences USING btree (tenant_id, task_id, due_at DESC NULLS LAST) WHERE (task_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX schedule_occurrences_workflow_idx ON subkit.schedule_occurrences USING btree (tenant_id, workflow_id, due_at DESC NULLS LAST) WHERE (workflow_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX schema_versions_connector_endpoint_seen_idx ON subkit.schema_versions USING btree (connector_id, endpoint_key, seen_at);
--> statement-breakpoint
CREATE INDEX schema_versions_provenance_seen_idx ON subkit.schema_versions USING btree (tenant_id, connector_id, endpoint_key, workflow_id, step_id, seen_at);
--> statement-breakpoint
CREATE UNIQUE INDEX self_healing_scans_idem_key ON subkit.self_healing_scans USING btree (tenant_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX self_healing_scans_tenant_created_idx ON subkit.self_healing_scans USING btree (tenant_id, created_at);
--> statement-breakpoint
CREATE INDEX sessions_absolute_expires_idx ON subkit.sessions USING btree (absolute_expires_at);
--> statement-breakpoint
CREATE INDEX sessions_installation_idx ON subkit.sessions USING btree (installation_id);
--> statement-breakpoint
CREATE INDEX sessions_last_seen_idx ON subkit.sessions USING btree (last_seen_at);
--> statement-breakpoint
CREATE INDEX sessions_token_sha256_idx ON subkit.sessions USING btree (token_sha256);
--> statement-breakpoint
CREATE INDEX sessions_user_expires_idx ON subkit.sessions USING btree (user_id, expires_at);
--> statement-breakpoint
CREATE INDEX skill_candidate_evidence_candidate_idx ON subkit.skill_candidate_evidence USING btree (skill_candidate_id);
--> statement-breakpoint
CREATE UNIQUE INDEX skill_candidate_evidence_identity_idx ON subkit.skill_candidate_evidence USING btree (skill_candidate_id, evidence_type, COALESCE((execution_id)::text, ''::text), COALESCE((patch_candidate_id)::text, ''::text), (
CASE
    WHEN ((execution_id IS NULL) AND (patch_candidate_id IS NULL)) THEN summary
    ELSE ''::text
END));
--> statement-breakpoint
CREATE INDEX skill_candidates_tenant_connector_idx ON subkit.skill_candidates USING btree (tenant_id, connector_id);
--> statement-breakpoint
CREATE INDEX skill_candidates_tenant_fingerprint_idx ON subkit.skill_candidates USING btree (tenant_id, fingerprint);
--> statement-breakpoint
CREATE INDEX skill_candidates_tenant_status_idx ON subkit.skill_candidates USING btree (tenant_id, status);
--> statement-breakpoint
CREATE INDEX skill_candidates_tenant_workflow_idx ON subkit.skill_candidates USING btree (tenant_id, workflow_id);
--> statement-breakpoint
CREATE INDEX skill_effectiveness_tenant_skill_idx ON subkit.skill_effectiveness USING btree (tenant_id, skill_id);
--> statement-breakpoint
CREATE UNIQUE INDEX skill_effectiveness_tenant_skill_proposal_key ON subkit.skill_effectiveness USING btree (tenant_id, skill_id, intake_proposal_id);
--> statement-breakpoint
CREATE INDEX skills_tenant_category_idx ON subkit.skills USING btree (tenant_id, category);
--> statement-breakpoint
CREATE INDEX skills_tenant_scope_connector_idx ON subkit.skills USING btree (tenant_id, scope, connector_id);
--> statement-breakpoint
CREATE INDEX skills_tenant_scope_workflow_idx ON subkit.skills USING btree (tenant_id, scope, workflow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX skills_tenant_slug_uq ON subkit.skills USING btree (tenant_id, slug) WHERE (slug IS NOT NULL);
--> statement-breakpoint
CREATE INDEX subscriptions_tenant_active_idx ON subkit.subscriptions USING btree (tenant_id, active);
--> statement-breakpoint
CREATE UNIQUE INDEX system_accounts_tenant_name_key ON subkit.system_accounts USING btree (tenant_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX task_grants_one_unrevoked_key ON subkit.task_grants USING btree (tenant_id, task_id, environment) WHERE (revoked_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX task_grants_tenant_id_key ON subkit.task_grants USING btree (tenant_id, id);
--> statement-breakpoint
CREATE INDEX task_grants_tenant_task_idx ON subkit.task_grants USING btree (tenant_id, task_id);
--> statement-breakpoint
CREATE UNIQUE INDEX task_runs_one_open_run_key ON subkit.task_runs USING btree (tenant_id, task_id) WHERE (state = ANY (ARRAY['running'::text, 'waiting'::text, 'sleeping'::text]));
--> statement-breakpoint
CREATE UNIQUE INDEX task_runs_one_run_per_conversation_key ON subkit.task_runs USING btree (tenant_id, conversation_id) WHERE (conversation_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX task_runs_tenant_conversation_idx ON subkit.task_runs USING btree (tenant_id, conversation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX task_runs_tenant_id_key ON subkit.task_runs USING btree (tenant_id, id);
--> statement-breakpoint
CREATE INDEX task_runs_tenant_task_created_idx ON subkit.task_runs USING btree (tenant_id, task_id, created_at DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX task_runs_tenant_wake_idx ON subkit.task_runs USING btree (tenant_id, next_check_at) WHERE (state = 'sleeping'::text);
--> statement-breakpoint
CREATE INDEX tasks_tenant_category_idx ON subkit.tasks USING btree (tenant_id, category);
--> statement-breakpoint
CREATE UNIQUE INDEX tasks_tenant_id_key ON subkit.tasks USING btree (tenant_id, id);
--> statement-breakpoint
CREATE INDEX tasks_tenant_owner_idx ON subkit.tasks USING btree (tenant_id, owner_id);
--> statement-breakpoint
CREATE INDEX tenant_skill_overrides_pk_idx ON subkit.tenant_skill_overrides USING btree (tenant_id, skill_slug);
--> statement-breakpoint
CREATE UNIQUE INDEX tenants_operator_key ON subkit.tenants USING btree (is_operator) WHERE is_operator;
--> statement-breakpoint
CREATE UNIQUE INDEX tenants_owner_identity_key ON subkit.tenants USING btree (owner_identity_id);
--> statement-breakpoint
CREATE UNIQUE INDEX tenants_slug_key ON subkit.tenants USING btree (slug);
--> statement-breakpoint
CREATE INDEX tool_approval_rules_owner_state_idx ON subkit.tool_approval_rules USING btree (tenant_id, user_id, state);
--> statement-breakpoint
CREATE UNIQUE INDEX tool_approval_rules_scope_key ON subkit.tool_approval_rules USING btree (tenant_id, user_id, scope_hash);
--> statement-breakpoint
CREATE INDEX tool_approvals_expiry_sweep_idx ON subkit.tool_approvals USING btree (expires_at) WHERE (consumed_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX tool_approvals_portal_token_sha256_key ON subkit.tool_approvals USING btree (portal_token_sha256);
--> statement-breakpoint
CREATE INDEX tool_approvals_tenant_id_idx ON subkit.tool_approvals USING btree (tenant_id, id);
--> statement-breakpoint
CREATE INDEX usage_events_tenant_surface_created_idx ON subkit.usage_events USING btree (tenant_id, surface, created_at);
--> statement-breakpoint
CREATE INDEX usage_events_tenant_traffic_created_idx ON subkit.usage_events USING btree (tenant_id, traffic_class, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX user_identities_tenant_provider_subject_key ON subkit.user_identities USING btree (tenant_id, provider_id, subject);
--> statement-breakpoint
CREATE INDEX user_identities_tenant_user_idx ON subkit.user_identities USING btree (tenant_id, user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX user_identities_tenant_user_provider_key ON subkit.user_identities USING btree (tenant_id, user_id, provider_id);
--> statement-breakpoint
CREATE UNIQUE INDEX user_invites_prefix_key ON subkit.user_invites USING btree (prefix);
--> statement-breakpoint
CREATE INDEX user_invites_tenant_user_idx ON subkit.user_invites USING btree (tenant_id, user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX user_llm_settings_tenant_user_uq ON subkit.user_llm_settings USING btree (tenant_id, user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX users_tenant_auth_identity_key ON subkit.users USING btree (tenant_id, auth_identity_id);
--> statement-breakpoint
CREATE UNIQUE INDEX users_tenant_email_key ON subkit.users USING btree (tenant_id, email);
--> statement-breakpoint
CREATE UNIQUE INDEX vault_items_connector_env_mode_key ON subkit.vault_items USING btree (connector_id, environment, mode);
--> statement-breakpoint
CREATE UNIQUE INDEX vault_items_name_key ON subkit.vault_items USING btree (tenant_id, COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), name, environment) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX vault_items_owner_idx ON subkit.vault_items USING btree (tenant_id, owner_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX vault_items_template_slug_key ON subkit.vault_items USING btree (tenant_id, template_slug) WHERE (kind = 'template_client'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX vendor_recipe_overrides_tenant_client_uq ON subkit.vendor_recipe_overrides USING btree (tenant_id, client);
--> statement-breakpoint
CREATE UNIQUE INDEX webhook_replay_seen_key ON subkit.webhook_replay_seen USING btree (tenant_id, webhook_id, standard_webhook_id);
--> statement-breakpoint
CREATE INDEX webhook_replay_seen_seen_at_idx ON subkit.webhook_replay_seen USING btree (seen_at);
--> statement-breakpoint
CREATE UNIQUE INDEX webhooks_inbound_slug_key ON subkit.webhooks_inbound USING btree (slug);
--> statement-breakpoint
CREATE INDEX webhooks_outbound_tenant_sub_idx ON subkit.webhooks_outbound USING btree (tenant_id, subscription_id);
--> statement-breakpoint
CREATE INDEX workflow_authorities_boundary_idx ON subkit.workflow_execution_authorities USING btree (tenant_id, workflow_id, workflow_version_id, execution_environment) WHERE (revoked_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_authorities_execution_binding_key ON subkit.workflow_execution_authorities USING btree (tenant_id, id, workflow_id, workflow_version_id, execution_environment);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_authorities_inherited_from_key ON subkit.workflow_execution_authorities USING btree (tenant_id, inherited_from) WHERE (inherited_from IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_authorities_tenant_id_key ON subkit.workflow_execution_authorities USING btree (tenant_id, id);
--> statement-breakpoint
CREATE INDEX workflow_authority_pair_requests_state_idx ON subkit.workflow_authority_pair_requests USING btree (tenant_id, state);
--> statement-breakpoint
CREATE INDEX workflow_authority_pair_requests_workflow_idx ON subkit.workflow_authority_pair_requests USING btree (tenant_id, workflow_id);
--> statement-breakpoint
CREATE INDEX workflow_autoheal_policies_tenant_idx ON subkit.workflow_autoheal_policies USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_autoheal_policies_workflow_key ON subkit.workflow_autoheal_policies USING btree (workflow_id);
--> statement-breakpoint
CREATE INDEX workflow_review_receipts_expiry_idx ON subkit.workflow_review_receipts USING btree (expires_at) WHERE (status = 'pending'::text);
--> statement-breakpoint
CREATE INDEX workflow_review_receipts_tenant_conversation_idx ON subkit.workflow_review_receipts USING btree (tenant_id, conversation_id);
--> statement-breakpoint
CREATE INDEX workflow_review_receipts_tenant_workflow_idx ON subkit.workflow_review_receipts USING btree (tenant_id, workflow_id);
--> statement-breakpoint
CREATE INDEX workflow_run_state_tenant_workflow_idx ON subkit.workflow_run_state USING btree (tenant_id, workflow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_run_state_tenant_workflow_key_uniq ON subkit.workflow_run_state USING btree (tenant_id, workflow_id, key);
--> statement-breakpoint
CREATE INDEX workflow_signals_match_idx ON subkit.workflow_signals USING btree (tenant_id, execution_id, event_name);
--> statement-breakpoint
CREATE INDEX workflow_signals_received_at_idx ON subkit.workflow_signals USING btree (received_at);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_versions_tenant_workflow_id_key ON subkit.workflow_versions USING btree (tenant_id, workflow_id, id);
--> statement-breakpoint
CREATE INDEX workflow_versions_tenant_workflow_idx ON subkit.workflow_versions USING btree (tenant_id, workflow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_versions_workflow_version_key ON subkit.workflow_versions USING btree (workflow_id, version);
--> statement-breakpoint
CREATE INDEX workflow_waits_sleep_until_idx ON subkit.workflow_waits USING btree (sleep_until_ts);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_waits_tenant_execution_step_uniq ON subkit.workflow_waits USING btree (tenant_id, execution_id, step_id);
--> statement-breakpoint
CREATE UNIQUE INDEX workflows_schedules_tenant_workflow_uidx ON subkit.workflows_schedules USING btree (tenant_id, workflow_id);
--> statement-breakpoint
CREATE INDEX workflows_tenant_category_idx ON subkit.workflows USING btree (tenant_id, category);
--> statement-breakpoint
CREATE UNIQUE INDEX workflows_tenant_id_key ON subkit.workflows USING btree (tenant_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX workflows_tenant_slug_active_key ON subkit.workflows USING btree (tenant_id, slug) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX workflows_tool_catalog_lru_idx ON subkit.workflows USING btree (tenant_id, last_executed_at DESC NULLS LAST, created_at) WHERE ((is_tool = true) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE TRIGGER api_key_credential_origin_guard BEFORE UPDATE OF credential_origin ON subkit.api_keys FOR EACH ROW EXECUTE FUNCTION subkit.api_key_credential_origin_immutable();
--> statement-breakpoint
CREATE TRIGGER approval_execution_link_guard BEFORE UPDATE ON subkit.tool_approvals FOR EACH ROW EXECUTE FUNCTION subkit.guard_approval_execution_link();
--> statement-breakpoint
CREATE TRIGGER authorized_workflow_version_guard BEFORE UPDATE ON subkit.workflow_versions FOR EACH ROW EXECUTE FUNCTION subkit.guard_authorized_workflow_version();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON subkit.connectors FOR EACH ROW EXECUTE FUNCTION subkit.catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON subkit.files FOR EACH ROW EXECUTE FUNCTION subkit.catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON subkit.intake_category_defaults FOR EACH ROW EXECUTE FUNCTION subkit.catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON subkit.intake_items FOR EACH ROW EXECUTE FUNCTION subkit.catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON subkit.knowledge_sources FOR EACH ROW EXECUTE FUNCTION subkit.catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON subkit.skills FOR EACH ROW EXECUTE FUNCTION subkit.catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON subkit.workflows FOR EACH ROW EXECUTE FUNCTION subkit.catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER execution_authority_binding_guard BEFORE UPDATE ON subkit.executions FOR EACH ROW EXECUTE FUNCTION subkit.guard_execution_authority_binding();
--> statement-breakpoint
CREATE TRIGGER execution_authority_link_guard BEFORE UPDATE ON subkit.executions FOR EACH ROW EXECUTE FUNCTION subkit.guard_execution_authority_link();
--> statement-breakpoint
CREATE TRIGGER execution_authority_reservation BEFORE INSERT ON subkit.executions FOR EACH ROW EXECUTE FUNCTION subkit.reserve_execution_authority();
--> statement-breakpoint
CREATE TRIGGER hosted_cascade_group_members BEFORE DELETE ON subkit.groups FOR EACH ROW EXECUTE FUNCTION subkit.hosted_cascade_group_members();
--> statement-breakpoint
CREATE TRIGGER hosted_cascade_group_role_assignments BEFORE DELETE ON subkit.groups FOR EACH ROW EXECUTE FUNCTION subkit.hosted_cascade_group_role_assignments();
--> statement-breakpoint
CREATE TRIGGER hosted_cascade_role_permissions BEFORE DELETE ON subkit.roles FOR EACH ROW EXECUTE FUNCTION subkit.hosted_cascade_role_permissions();
--> statement-breakpoint
CREATE TRIGGER hosted_cascade_skill_candidate_evidence BEFORE DELETE ON subkit.skill_candidates FOR EACH ROW EXECUTE FUNCTION subkit.hosted_cascade_skill_candidate_evidence();
--> statement-breakpoint
CREATE TRIGGER hosted_initialize_usage AFTER INSERT ON subkit.tenants FOR EACH ROW EXECUTE FUNCTION subkit.hosted_initialize_usage();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_api_keys AFTER INSERT OR DELETE OR UPDATE ON subkit.api_keys FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_api_keys();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_audit_log AFTER INSERT OR DELETE OR UPDATE ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_audit_log();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_auth_provider_configs AFTER INSERT OR DELETE OR UPDATE ON subkit.auth_provider_configs FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_auth_provider_configs();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_catalog_categories AFTER INSERT OR DELETE OR UPDATE ON subkit.catalog_categories FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_catalog_categories();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_chat_deliveries AFTER INSERT OR DELETE OR UPDATE ON subkit.chat_deliveries FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_chat_deliveries();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_chat_identities AFTER INSERT OR DELETE OR UPDATE ON subkit.chat_identities FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_chat_identities();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_chat_sessions AFTER INSERT OR DELETE OR UPDATE ON subkit.chat_sessions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_chat_sessions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_chat_workspaces AFTER INSERT OR DELETE OR UPDATE ON subkit.chat_workspaces FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_chat_workspaces();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_cli_notification_inbox AFTER INSERT OR DELETE OR UPDATE ON subkit.cli_notification_inbox FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_cli_notification_inbox();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_cli_notification_inbox_reads AFTER INSERT OR DELETE OR UPDATE ON subkit.cli_notification_inbox_reads FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_cli_notification_inbox_reads();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_cockpit_installations AFTER INSERT OR DELETE OR UPDATE ON subkit.cockpit_installations FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_cockpit_installations();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_cockpit_push_keys AFTER INSERT OR DELETE OR UPDATE ON subkit.cockpit_push_keys FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_cockpit_push_keys();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_cockpit_push_subscriptions AFTER INSERT OR DELETE OR UPDATE ON subkit.cockpit_push_subscriptions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_cockpit_push_subscriptions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_connector_document_chunks AFTER INSERT OR DELETE OR UPDATE ON subkit.connector_document_chunks FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_document_chunks();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_connector_documents AFTER INSERT OR DELETE OR UPDATE ON subkit.connector_documents FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_documents();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_connector_endpoint_schemas AFTER INSERT OR DELETE OR UPDATE ON subkit.connector_endpoint_schemas FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_endpoint_schemas();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_connector_environments AFTER INSERT OR DELETE OR UPDATE ON subkit.connector_environments FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_environments();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_connector_mcp_sessions AFTER INSERT OR DELETE OR UPDATE ON subkit.connector_mcp_sessions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_mcp_sessions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_connector_promotions AFTER INSERT OR DELETE OR UPDATE ON subkit.connector_promotions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_promotions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_connector_templates AFTER INSERT OR DELETE OR UPDATE ON subkit.connector_templates FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_templates();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_connectors AFTER INSERT OR DELETE OR UPDATE ON subkit.connectors FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connectors();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_conversation_draft_snapshots AFTER INSERT OR DELETE OR UPDATE ON subkit.conversation_draft_snapshots FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_draft_snapshots();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_conversation_drafts AFTER INSERT OR DELETE OR UPDATE ON subkit.conversation_drafts FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_drafts();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_conversation_elicitations AFTER INSERT OR DELETE OR UPDATE ON subkit.conversation_elicitations FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_elicitations();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_conversation_hidden AFTER INSERT OR DELETE OR UPDATE ON subkit.conversation_hidden FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_hidden();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_conversation_messages AFTER INSERT OR DELETE OR UPDATE ON subkit.conversation_messages FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_messages();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_conversation_tool_calls AFTER INSERT OR DELETE OR UPDATE ON subkit.conversation_tool_calls FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_tool_calls();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_conversations AFTER INSERT OR DELETE OR UPDATE ON subkit.conversations FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversations();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_deliveries AFTER INSERT OR DELETE OR UPDATE ON subkit.deliveries FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_deliveries();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_discovery_artifacts AFTER INSERT OR DELETE OR UPDATE ON subkit.discovery_artifacts FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_discovery_artifacts();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_discovery_files AFTER INSERT OR DELETE OR UPDATE ON subkit.discovery_files FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_discovery_files();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_discovery_runs AFTER INSERT OR DELETE OR UPDATE ON subkit.discovery_runs FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_discovery_runs();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_events AFTER INSERT OR DELETE OR UPDATE ON subkit.events FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_events();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_execution_fixtures AFTER INSERT OR DELETE OR UPDATE ON subkit.execution_fixtures FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_execution_fixtures();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_execution_steps AFTER INSERT OR DELETE OR UPDATE ON subkit.execution_steps FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_execution_steps();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_executions AFTER INSERT OR DELETE OR UPDATE ON subkit.executions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_executions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_file_links AFTER INSERT OR DELETE OR UPDATE ON subkit.file_links FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_file_links();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_file_versions AFTER INSERT OR DELETE OR UPDATE ON subkit.file_versions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_file_versions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_files AFTER INSERT OR DELETE OR UPDATE ON subkit.files FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_files();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_group_members AFTER INSERT OR DELETE OR UPDATE ON subkit.group_members FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_group_members();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_group_role_assignments AFTER INSERT OR DELETE OR UPDATE ON subkit.group_role_assignments FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_group_role_assignments();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_groups AFTER INSERT OR DELETE OR UPDATE ON subkit.groups FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_groups();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_hosted_storage_objects AFTER INSERT OR DELETE OR UPDATE ON subkit.hosted_storage_objects FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_hosted_storage_objects();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_intake_category_defaults AFTER INSERT OR DELETE OR UPDATE ON subkit.intake_category_defaults FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_category_defaults();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_intake_item_evidence AFTER INSERT OR DELETE OR UPDATE ON subkit.intake_item_evidence FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_item_evidence();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_intake_items AFTER INSERT OR DELETE OR UPDATE ON subkit.intake_items FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_items();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_intake_proposal_items AFTER INSERT OR DELETE OR UPDATE ON subkit.intake_proposal_items FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_proposal_items();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_intake_proposal_revisions AFTER INSERT OR DELETE OR UPDATE ON subkit.intake_proposal_revisions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_proposal_revisions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_intake_proposals AFTER INSERT OR DELETE OR UPDATE ON subkit.intake_proposals FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_proposals();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_knowledge_chunks AFTER INSERT OR DELETE OR UPDATE ON subkit.knowledge_chunks FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_knowledge_chunks();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_knowledge_source_versions AFTER INSERT OR DELETE OR UPDATE ON subkit.knowledge_source_versions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_knowledge_source_versions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_knowledge_sources AFTER INSERT OR DELETE OR UPDATE ON subkit.knowledge_sources FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_knowledge_sources();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_mcp_tasks AFTER INSERT OR DELETE OR UPDATE ON subkit.mcp_tasks FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_mcp_tasks();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_notification_channels AFTER INSERT OR DELETE OR UPDATE ON subkit.notification_channels FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_notification_channels();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_notification_deliveries AFTER INSERT OR DELETE OR UPDATE ON subkit.notification_deliveries FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_notification_deliveries();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_notification_rules AFTER INSERT OR DELETE OR UPDATE ON subkit.notification_rules FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_notification_rules();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_outbound_connection_starts AFTER INSERT OR DELETE OR UPDATE ON subkit.outbound_connection_starts FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_outbound_connection_starts();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_outbound_connections AFTER INSERT OR DELETE OR UPDATE ON subkit.outbound_connections FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_outbound_connections();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_package_install_items AFTER INSERT OR DELETE OR UPDATE ON subkit.package_install_items FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_package_install_items();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_package_installs AFTER INSERT OR DELETE OR UPDATE ON subkit.package_installs FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_package_installs();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_patch_candidates AFTER INSERT OR DELETE OR UPDATE ON subkit.patch_candidates FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_patch_candidates();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_portal_tokens AFTER INSERT OR DELETE OR UPDATE ON subkit.portal_tokens FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_portal_tokens();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_request_hooks AFTER INSERT OR DELETE OR UPDATE ON subkit.request_hooks FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_request_hooks();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_resource_grants AFTER INSERT OR DELETE OR UPDATE ON subkit.resource_grants FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_resource_grants();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_role_permissions AFTER INSERT OR DELETE OR UPDATE ON subkit.role_permissions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_role_permissions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_roles AFTER INSERT OR DELETE OR UPDATE ON subkit.roles FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_roles();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_runtime_secret_versions AFTER INSERT OR DELETE OR UPDATE ON subkit.runtime_secret_versions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_runtime_secret_versions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_schema_versions AFTER INSERT OR DELETE OR UPDATE ON subkit.schema_versions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_schema_versions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_self_healing_scans AFTER INSERT OR DELETE OR UPDATE ON subkit.self_healing_scans FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_self_healing_scans();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_skill_candidate_evidence AFTER INSERT OR DELETE OR UPDATE ON subkit.skill_candidate_evidence FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_skill_candidate_evidence();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_skill_candidates AFTER INSERT OR DELETE OR UPDATE ON subkit.skill_candidates FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_skill_candidates();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_skill_effectiveness AFTER INSERT OR DELETE OR UPDATE ON subkit.skill_effectiveness FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_skill_effectiveness();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_skills AFTER INSERT OR DELETE OR UPDATE ON subkit.skills FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_skills();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_subscriptions AFTER INSERT OR DELETE OR UPDATE ON subkit.subscriptions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_subscriptions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_system_accounts AFTER INSERT OR DELETE OR UPDATE ON subkit.system_accounts FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_system_accounts();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_tasks AFTER INSERT OR DELETE OR UPDATE ON subkit.tasks FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tasks();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_tenant_branding AFTER INSERT OR DELETE OR UPDATE ON subkit.tenant_branding FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tenant_branding();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_tenant_skill_overrides AFTER INSERT OR DELETE OR UPDATE ON subkit.tenant_skill_overrides FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tenant_skill_overrides();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_tenants AFTER INSERT OR DELETE OR UPDATE ON subkit.tenants FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tenants();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_tool_approvals AFTER INSERT OR DELETE OR UPDATE ON subkit.tool_approvals FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tool_approvals();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_user_identities AFTER INSERT OR DELETE OR UPDATE ON subkit.user_identities FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_user_identities();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_user_invites AFTER INSERT OR DELETE OR UPDATE ON subkit.user_invites FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_user_invites();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_user_llm_settings AFTER INSERT OR DELETE OR UPDATE ON subkit.user_llm_settings FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_user_llm_settings();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_users AFTER INSERT OR DELETE OR UPDATE ON subkit.users FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_users();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_vault_items AFTER INSERT OR DELETE OR UPDATE ON subkit.vault_items FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_vault_items();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_vendor_recipe_overrides AFTER INSERT OR DELETE OR UPDATE ON subkit.vendor_recipe_overrides FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_vendor_recipe_overrides();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_webhooks_inbound AFTER INSERT OR DELETE OR UPDATE ON subkit.webhooks_inbound FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_webhooks_inbound();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_webhooks_outbound AFTER INSERT OR DELETE OR UPDATE ON subkit.webhooks_outbound FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_webhooks_outbound();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_workflow_autoheal_policies AFTER INSERT OR DELETE OR UPDATE ON subkit.workflow_autoheal_policies FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_autoheal_policies();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_workflow_execution_authorities AFTER INSERT OR DELETE OR UPDATE ON subkit.workflow_execution_authorities FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_execution_authorities();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_workflow_review_receipts AFTER INSERT OR DELETE OR UPDATE ON subkit.workflow_review_receipts FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_review_receipts();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_workflow_run_state AFTER INSERT OR DELETE OR UPDATE ON subkit.workflow_run_state FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_run_state();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_workflow_signals AFTER INSERT OR DELETE OR UPDATE ON subkit.workflow_signals FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_signals();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_workflow_versions AFTER INSERT OR DELETE OR UPDATE ON subkit.workflow_versions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_versions();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_workflow_waits AFTER INSERT OR DELETE OR UPDATE ON subkit.workflow_waits FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_waits();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_workflows AFTER INSERT OR DELETE OR UPDATE ON subkit.workflows FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflows();
--> statement-breakpoint
CREATE TRIGGER hosted_meter_workflows_schedules AFTER INSERT OR DELETE OR UPDATE ON subkit.workflows_schedules FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflows_schedules();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.caller_budget_units FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.chat_composer_attachments FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.chat_events_seen FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.connector_credential_setup_grants FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.connector_oauth_start_grants FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.connector_oauth_states FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.conversation_turns FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.desktop_login_codes FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.external_call_metering FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.hosted_storage_objects FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.hosted_work_admissions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.llm_usage FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.mcp_oauth_access_tokens FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.mcp_oauth_authorization_codes FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.mcp_oauth_grants FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.mcp_oauth_refresh_tokens FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.mcp_oauth_states FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.mcp_oauth_unknown_grants FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.oidc_login_states FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.product_identity_tombstones FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.sessions FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.tenant_erasure_states FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.usage_events FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.webhook_replay_seen FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
--> statement-breakpoint
CREATE TRIGGER hosted_singleton_control_guard BEFORE INSERT OR UPDATE ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.hosted_singleton_control_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER hosted_terminal_receipt_required AFTER INSERT OR UPDATE ON subkit.executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION subkit.hosted_terminal_receipt_required();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER hosted_terminal_receipt_required AFTER INSERT OR UPDATE ON subkit.mcp_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION subkit.hosted_terminal_receipt_required();
--> statement-breakpoint
CREATE TRIGGER intake_item_evidence_append_only BEFORE UPDATE ON subkit.intake_item_evidence FOR EACH ROW EXECUTE FUNCTION subkit.guard_intake_item_evidence_append_only();
--> statement-breakpoint
CREATE TRIGGER preparation_execution_guard BEFORE INSERT OR UPDATE ON subkit.executions FOR EACH ROW EXECUTE FUNCTION subkit.guard_preparation_execution();
--> statement-breakpoint
CREATE TRIGGER rbac_check_group_member_tenant BEFORE INSERT OR UPDATE ON subkit.group_members FOR EACH ROW EXECUTE FUNCTION subkit.rbac_check_group_member_tenant();
--> statement-breakpoint
CREATE TRIGGER rbac_check_group_role_tenant BEFORE INSERT OR UPDATE ON subkit.group_role_assignments FOR EACH ROW EXECUTE FUNCTION subkit.rbac_check_group_role_tenant();
--> statement-breakpoint
CREATE TRIGGER rbac_check_group_tenant_transfer BEFORE UPDATE OF tenant_id ON subkit.groups FOR EACH ROW EXECUTE FUNCTION subkit.rbac_check_parent_tenant_transfer();
--> statement-breakpoint
CREATE TRIGGER rbac_check_role_tenant_transfer BEFORE UPDATE OF tenant_id ON subkit.roles FOR EACH ROW EXECUTE FUNCTION subkit.rbac_check_parent_tenant_transfer();
--> statement-breakpoint
CREATE TRIGGER rbac_check_user_tenant_transfer BEFORE UPDATE OF tenant_id ON subkit.users FOR EACH ROW EXECUTE FUNCTION subkit.rbac_check_parent_tenant_transfer();
--> statement-breakpoint
CREATE TRIGGER runtime_secret_owner_guard BEFORE INSERT OR UPDATE ON subkit.runtime_secret_versions FOR EACH ROW EXECUTE FUNCTION subkit.runtime_secret_owner_guard();
--> statement-breakpoint
CREATE TRIGGER tool_approval_execution_guard BEFORE INSERT OR UPDATE ON subkit.executions FOR EACH ROW EXECUTE FUNCTION subkit.guard_tool_approval_execution();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER vault_maintenance_commit_guard AFTER INSERT OR UPDATE ON subkit.runtime_config_state DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION subkit.vault_maintenance_commit_guard();
--> statement-breakpoint
CREATE TRIGGER vault_maintenance_context_guard BEFORE INSERT OR DELETE OR UPDATE ON subkit.runtime_config_state FOR EACH ROW EXECUTE FUNCTION subkit.vault_maintenance_context_guard();
--> statement-breakpoint
CREATE TRIGGER workflow_execution_authority_boundary_guard BEFORE UPDATE ON subkit.workflow_execution_authorities FOR EACH ROW EXECUTE FUNCTION subkit.guard_workflow_execution_authority();
--> statement-breakpoint
ALTER TABLE ONLY subkit.api_keys
    ADD CONSTRAINT api_keys_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.auth_provider_configs
    ADD CONSTRAINT auth_provider_configs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.caller_budget_units
    ADD CONSTRAINT caller_budget_units_principal_id_users_id_fk FOREIGN KEY (principal_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.caller_budget_units
    ADD CONSTRAINT caller_budget_units_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.catalog_categories
    ADD CONSTRAINT catalog_categories_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_composer_attachments
    ADD CONSTRAINT chat_composer_attachments_file_id_files_id_fk FOREIGN KEY (file_id) REFERENCES subkit.files(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_composer_attachments
    ADD CONSTRAINT chat_composer_attachments_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_composer_attachments
    ADD CONSTRAINT chat_composer_attachments_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_deliveries
    ADD CONSTRAINT chat_deliveries_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_deliveries
    ADD CONSTRAINT chat_deliveries_workspace_id_chat_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES subkit.chat_workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_events_seen
    ADD CONSTRAINT chat_events_seen_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_events_seen
    ADD CONSTRAINT chat_events_seen_workspace_id_chat_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES subkit.chat_workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_identities
    ADD CONSTRAINT chat_identities_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_identities
    ADD CONSTRAINT chat_identities_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_sessions
    ADD CONSTRAINT chat_sessions_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_sessions
    ADD CONSTRAINT chat_sessions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_sessions
    ADD CONSTRAINT chat_sessions_workspace_id_chat_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES subkit.chat_workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.chat_workspaces
    ADD CONSTRAINT chat_workspaces_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cli_notification_inbox
    ADD CONSTRAINT cli_notification_inbox_delivery_id_notification_deliveries_id_f FOREIGN KEY (delivery_id) REFERENCES subkit.notification_deliveries(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cli_notification_inbox_reads
    ADD CONSTRAINT cli_notification_inbox_reads_inbox_id_cli_notification_inbox_id FOREIGN KEY (inbox_id) REFERENCES subkit.cli_notification_inbox(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cli_notification_inbox_reads
    ADD CONSTRAINT cli_notification_inbox_reads_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cli_notification_inbox_reads
    ADD CONSTRAINT cli_notification_inbox_reads_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cli_notification_inbox
    ADD CONSTRAINT cli_notification_inbox_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cockpit_installations
    ADD CONSTRAINT cockpit_installations_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cockpit_installations
    ADD CONSTRAINT cockpit_installations_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cockpit_push_keys
    ADD CONSTRAINT cockpit_push_keys_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cockpit_push_subscriptions
    ADD CONSTRAINT cockpit_push_subscriptions_installation_id_cockpit_installation FOREIGN KEY (installation_id) REFERENCES subkit.cockpit_installations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cockpit_push_subscriptions
    ADD CONSTRAINT cockpit_push_subscriptions_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES subkit.sessions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cockpit_push_subscriptions
    ADD CONSTRAINT cockpit_push_subscriptions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.cockpit_push_subscriptions
    ADD CONSTRAINT cockpit_push_subscriptions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_credential_setup_grants
    ADD CONSTRAINT connector_credential_setup_grants_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_credential_setup_grants
    ADD CONSTRAINT connector_credential_setup_grants_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_document_chunks
    ADD CONSTRAINT connector_document_chunks_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_document_chunks
    ADD CONSTRAINT connector_document_chunks_document_id_connector_documents_id_fk FOREIGN KEY (document_id) REFERENCES subkit.connector_documents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_document_chunks
    ADD CONSTRAINT connector_document_chunks_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_documents
    ADD CONSTRAINT connector_documents_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_documents
    ADD CONSTRAINT connector_documents_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_endpoint_schemas
    ADD CONSTRAINT connector_endpoint_schemas_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_endpoint_schemas
    ADD CONSTRAINT connector_endpoint_schemas_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_environments
    ADD CONSTRAINT connector_environments_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_environments
    ADD CONSTRAINT connector_environments_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_mcp_sessions
    ADD CONSTRAINT connector_mcp_sessions_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_mcp_sessions
    ADD CONSTRAINT connector_mcp_sessions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_oauth_start_grants
    ADD CONSTRAINT connector_oauth_start_grants_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_oauth_start_grants
    ADD CONSTRAINT connector_oauth_start_grants_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_oauth_states
    ADD CONSTRAINT connector_oauth_states_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_oauth_states
    ADD CONSTRAINT connector_oauth_states_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_promotions
    ADD CONSTRAINT connector_promotions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connector_templates
    ADD CONSTRAINT connector_templates_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.connectors
    ADD CONSTRAINT connectors_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_draft_snapshots
    ADD CONSTRAINT conversation_draft_snapshots_conversation_id_conversations_id_f FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_draft_snapshots
    ADD CONSTRAINT conversation_draft_snapshots_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_drafts
    ADD CONSTRAINT conversation_drafts_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_drafts
    ADD CONSTRAINT conversation_drafts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_elicitations
    ADD CONSTRAINT conversation_elicitations_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_elicitations
    ADD CONSTRAINT conversation_elicitations_parent_message_id_conversation_messag FOREIGN KEY (parent_message_id) REFERENCES subkit.conversation_messages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_elicitations
    ADD CONSTRAINT conversation_elicitations_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_elicitations
    ADD CONSTRAINT conversation_elicitations_tool_call_id_conversation_tool_calls_ FOREIGN KEY (tool_call_id) REFERENCES subkit.conversation_tool_calls(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_hidden
    ADD CONSTRAINT conversation_hidden_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_hidden
    ADD CONSTRAINT conversation_hidden_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_messages
    ADD CONSTRAINT conversation_messages_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_messages
    ADD CONSTRAINT conversation_messages_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_tool_calls
    ADD CONSTRAINT conversation_tool_calls_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_tool_calls
    ADD CONSTRAINT conversation_tool_calls_parent_message_id_conversation_messages FOREIGN KEY (parent_message_id) REFERENCES subkit.conversation_messages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_tool_calls
    ADD CONSTRAINT conversation_tool_calls_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_turns
    ADD CONSTRAINT conversation_turns_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversation_turns
    ADD CONSTRAINT conversation_turns_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.conversations
    ADD CONSTRAINT conversations_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.deliveries
    ADD CONSTRAINT deliveries_subscription_id_subscriptions_id_fk FOREIGN KEY (subscription_id) REFERENCES subkit.subscriptions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.deliveries
    ADD CONSTRAINT deliveries_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.desktop_login_codes
    ADD CONSTRAINT desktop_login_codes_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.desktop_login_codes
    ADD CONSTRAINT desktop_login_codes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_allowances
    ADD CONSTRAINT device_allowances_device_runner_id_device_runners_id_fk FOREIGN KEY (device_runner_id) REFERENCES subkit.device_runners(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_allowances
    ADD CONSTRAINT device_allowances_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_commands
    ADD CONSTRAINT device_commands_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_commands
    ADD CONSTRAINT device_commands_device_id_device_runners_id_fk FOREIGN KEY (device_id) REFERENCES subkit.device_runners(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_commands
    ADD CONSTRAINT device_commands_execution_id_executions_id_fk FOREIGN KEY (execution_id) REFERENCES subkit.executions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_commands
    ADD CONSTRAINT device_commands_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_runner_nonces
    ADD CONSTRAINT device_runner_nonces_device_runner_id_device_runners_id_fk FOREIGN KEY (device_runner_id) REFERENCES subkit.device_runners(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_runner_nonces
    ADD CONSTRAINT device_runner_nonces_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_runners
    ADD CONSTRAINT device_runners_installation_id_cockpit_installations_id_fk FOREIGN KEY (installation_id) REFERENCES subkit.cockpit_installations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_runners
    ADD CONSTRAINT device_runners_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_runners
    ADD CONSTRAINT device_runners_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_upload_chunks
    ADD CONSTRAINT device_upload_chunks_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_upload_chunks
    ADD CONSTRAINT device_upload_chunks_upload_id_device_uploads_id_fk FOREIGN KEY (upload_id) REFERENCES subkit.device_uploads(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_uploads
    ADD CONSTRAINT device_uploads_command_id_device_commands_id_fk FOREIGN KEY (command_id) REFERENCES subkit.device_commands(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_uploads
    ADD CONSTRAINT device_uploads_device_id_device_runners_id_fk FOREIGN KEY (device_id) REFERENCES subkit.device_runners(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_uploads
    ADD CONSTRAINT device_uploads_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_waits
    ADD CONSTRAINT device_waits_device_id_device_runners_id_fk FOREIGN KEY (device_id) REFERENCES subkit.device_runners(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_waits
    ADD CONSTRAINT device_waits_execution_id_executions_id_fk FOREIGN KEY (execution_id) REFERENCES subkit.executions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.device_waits
    ADD CONSTRAINT device_waits_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.discovery_artifacts
    ADD CONSTRAINT discovery_artifacts_run_id_discovery_runs_id_fk FOREIGN KEY (run_id) REFERENCES subkit.discovery_runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.discovery_artifacts
    ADD CONSTRAINT discovery_artifacts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.discovery_files
    ADD CONSTRAINT discovery_files_run_id_discovery_runs_id_fk FOREIGN KEY (run_id) REFERENCES subkit.discovery_runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.discovery_files
    ADD CONSTRAINT discovery_files_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.discovery_runs
    ADD CONSTRAINT discovery_runs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.execution_fixtures
    ADD CONSTRAINT execution_fixtures_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.execution_fixtures
    ADD CONSTRAINT execution_fixtures_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.execution_steps
    ADD CONSTRAINT execution_steps_execution_id_executions_id_fk FOREIGN KEY (execution_id) REFERENCES subkit.executions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.execution_steps
    ADD CONSTRAINT execution_steps_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.executions
    ADD CONSTRAINT executions_exact_authority_fk FOREIGN KEY (tenant_id, execution_authority_id, workflow_id, workflow_version_id, execution_mode) REFERENCES subkit.workflow_execution_authorities(tenant_id, id, workflow_id, workflow_version_id, execution_environment) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY subkit.executions
    ADD CONSTRAINT executions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.executions
    ADD CONSTRAINT executions_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.executions
    ADD CONSTRAINT executions_workflow_version_id_workflow_versions_id_fk FOREIGN KEY (workflow_version_id) REFERENCES subkit.workflow_versions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.external_call_metering
    ADD CONSTRAINT external_call_metering_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.file_links
    ADD CONSTRAINT file_links_file_id_files_id_fk FOREIGN KEY (file_id) REFERENCES subkit.files(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.file_links
    ADD CONSTRAINT file_links_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.file_versions
    ADD CONSTRAINT file_versions_file_id_files_id_fk FOREIGN KEY (file_id) REFERENCES subkit.files(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.file_versions
    ADD CONSTRAINT file_versions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.files_dedup_seen
    ADD CONSTRAINT files_dedup_seen_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.files
    ADD CONSTRAINT files_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.group_members
    ADD CONSTRAINT group_members_group_id_groups_id_fk FOREIGN KEY (group_id) REFERENCES subkit.groups(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.group_members
    ADD CONSTRAINT group_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.group_role_assignments
    ADD CONSTRAINT group_role_assignments_group_id_groups_id_fk FOREIGN KEY (group_id) REFERENCES subkit.groups(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.group_role_assignments
    ADD CONSTRAINT group_role_assignments_role_id_roles_id_fk FOREIGN KEY (role_id) REFERENCES subkit.roles(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.groups
    ADD CONSTRAINT groups_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.hosted_storage_objects
    ADD CONSTRAINT hosted_storage_objects_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.hosted_tenant_usage
    ADD CONSTRAINT hosted_tenant_usage_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.hosted_work_admissions
    ADD CONSTRAINT hosted_work_admissions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.identity_recovery_sessions
    ADD CONSTRAINT identity_recovery_sessions_auth_identity_id_auth_identities_id_ FOREIGN KEY (auth_identity_id) REFERENCES subkit.auth_identities(id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_item_evidence
    ADD CONSTRAINT intake_item_evidence_item_id_intake_items_id_fk FOREIGN KEY (item_id) REFERENCES subkit.intake_items(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_item_evidence
    ADD CONSTRAINT intake_item_evidence_tenant_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_item_evidence
    ADD CONSTRAINT intake_item_evidence_tenant_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES subkit.intake_items(tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_items
    ADD CONSTRAINT intake_items_tenant_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposal_items
    ADD CONSTRAINT intake_proposal_items_item_id_intake_items_id_fk FOREIGN KEY (item_id) REFERENCES subkit.intake_items(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposal_items
    ADD CONSTRAINT intake_proposal_items_proposal_revision_id_intake_proposal_revi FOREIGN KEY (proposal_revision_id) REFERENCES subkit.intake_proposal_revisions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposal_items
    ADD CONSTRAINT intake_proposal_items_tenant_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposal_items
    ADD CONSTRAINT intake_proposal_items_tenant_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES subkit.intake_items(tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposal_items
    ADD CONSTRAINT intake_proposal_items_tenant_revision_fk FOREIGN KEY (tenant_id, proposal_revision_id) REFERENCES subkit.intake_proposal_revisions(tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposal_revisions
    ADD CONSTRAINT intake_proposal_revisions_proposal_id_intake_proposals_id_fk FOREIGN KEY (proposal_id) REFERENCES subkit.intake_proposals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposal_revisions
    ADD CONSTRAINT intake_proposal_revisions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposal_revisions
    ADD CONSTRAINT intake_proposal_revisions_tenant_proposal_fk FOREIGN KEY (tenant_id, proposal_id) REFERENCES subkit.intake_proposals(tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.intake_proposals
    ADD CONSTRAINT intake_proposals_tenant_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_knowledge_source_id_knowledge_sources_id_fk FOREIGN KEY (knowledge_source_id) REFERENCES subkit.knowledge_sources(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.knowledge_source_versions
    ADD CONSTRAINT knowledge_source_versions_knowledge_source_id_knowledge_sources FOREIGN KEY (knowledge_source_id) REFERENCES subkit.knowledge_sources(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.knowledge_source_versions
    ADD CONSTRAINT knowledge_source_versions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.knowledge_sources
    ADD CONSTRAINT knowledge_sources_file_id_files_id_fk FOREIGN KEY (file_id) REFERENCES subkit.files(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.knowledge_sources
    ADD CONSTRAINT knowledge_sources_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.knowledge_sources
    ADD CONSTRAINT knowledge_sources_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.llm_usage
    ADD CONSTRAINT llm_usage_execution_id_executions_id_fk FOREIGN KEY (execution_id) REFERENCES subkit.executions(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.llm_usage
    ADD CONSTRAINT llm_usage_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_access_tokens
    ADD CONSTRAINT mcp_oauth_access_tokens_grant_identity_fk FOREIGN KEY (grant_id, tenant_id, client_id, user_id) REFERENCES subkit.mcp_oauth_grants(id, tenant_id, client_id, user_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_access_tokens
    ADD CONSTRAINT mcp_oauth_access_tokens_refresh_token_id_mcp_oauth_refresh_toke FOREIGN KEY (refresh_token_id) REFERENCES subkit.mcp_oauth_refresh_tokens(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_access_tokens
    ADD CONSTRAINT mcp_oauth_access_tokens_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_authorization_codes
    ADD CONSTRAINT mcp_oauth_authorization_codes_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_grants
    ADD CONSTRAINT mcp_oauth_grants_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_refresh_tokens
    ADD CONSTRAINT mcp_oauth_refresh_tokens_grant_identity_fk FOREIGN KEY (grant_id, tenant_id, client_id, user_id) REFERENCES subkit.mcp_oauth_grants(id, tenant_id, client_id, user_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_refresh_tokens
    ADD CONSTRAINT mcp_oauth_refresh_tokens_rotated_to_id_mcp_oauth_refresh_tokens FOREIGN KEY (rotated_to_id) REFERENCES subkit.mcp_oauth_refresh_tokens(id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_refresh_tokens
    ADD CONSTRAINT mcp_oauth_refresh_tokens_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_states
    ADD CONSTRAINT mcp_oauth_states_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_states
    ADD CONSTRAINT mcp_oauth_states_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_oauth_unknown_grants
    ADD CONSTRAINT mcp_oauth_unknown_grants_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_tasks
    ADD CONSTRAINT mcp_tasks_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_tasks
    ADD CONSTRAINT mcp_tasks_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.mcp_tasks
    ADD CONSTRAINT mcp_tasks_user_message_id_conversation_messages_id_fk FOREIGN KEY (user_message_id) REFERENCES subkit.conversation_messages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.notification_channels
    ADD CONSTRAINT notification_channels_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.notification_deliveries
    ADD CONSTRAINT notification_deliveries_channel_id_notification_channels_id_fk FOREIGN KEY (channel_id) REFERENCES subkit.notification_channels(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.notification_deliveries
    ADD CONSTRAINT notification_deliveries_rule_id_notification_rules_id_fk FOREIGN KEY (rule_id) REFERENCES subkit.notification_rules(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.notification_deliveries
    ADD CONSTRAINT notification_deliveries_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.notification_rules
    ADD CONSTRAINT notification_rules_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.oidc_login_states
    ADD CONSTRAINT oidc_login_states_installation_id_cockpit_installations_id_fk FOREIGN KEY (installation_id) REFERENCES subkit.cockpit_installations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.oidc_login_states
    ADD CONSTRAINT oidc_login_states_membership_invite_id_user_invites_id_fk FOREIGN KEY (membership_invite_id) REFERENCES subkit.user_invites(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.outbound_connection_starts
    ADD CONSTRAINT outbound_connection_starts_connection_id_outbound_connections_i FOREIGN KEY (connection_id) REFERENCES subkit.outbound_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.outbound_connection_starts
    ADD CONSTRAINT outbound_connection_starts_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES subkit.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.outbound_connection_starts
    ADD CONSTRAINT outbound_connection_starts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.outbound_connections
    ADD CONSTRAINT outbound_connections_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES subkit.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.outbound_connections
    ADD CONSTRAINT outbound_connections_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.package_install_items
    ADD CONSTRAINT package_install_items_install_id_package_installs_id_fk FOREIGN KEY (install_id) REFERENCES subkit.package_installs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.package_install_items
    ADD CONSTRAINT package_install_items_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.package_installs
    ADD CONSTRAINT package_installs_archive_file_id_files_id_fk FOREIGN KEY (archive_file_id) REFERENCES subkit.files(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.package_installs
    ADD CONSTRAINT package_installs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.patch_candidates
    ADD CONSTRAINT patch_candidates_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.patch_candidates
    ADD CONSTRAINT patch_candidates_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.patch_candidates
    ADD CONSTRAINT patch_candidates_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.portal_tokens
    ADD CONSTRAINT portal_tokens_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.product_identity_tombstones
    ADD CONSTRAINT product_identity_tombstones_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.request_hooks
    ADD CONSTRAINT request_hooks_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.resource_grants
    ADD CONSTRAINT resource_grants_permission_id_permissions_id_fk FOREIGN KEY (permission_id) REFERENCES subkit.permissions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.resource_grants
    ADD CONSTRAINT resource_grants_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_permissions_id_fk FOREIGN KEY (permission_id) REFERENCES subkit.permissions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.role_permissions
    ADD CONSTRAINT role_permissions_role_id_roles_id_fk FOREIGN KEY (role_id) REFERENCES subkit.roles(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.roles
    ADD CONSTRAINT roles_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.runtime_secret_versions
    ADD CONSTRAINT runtime_secret_versions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.schedule_occurrences
    ADD CONSTRAINT schedule_occurrences_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES subkit.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.schedule_occurrences
    ADD CONSTRAINT schedule_occurrences_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.schedule_occurrences
    ADD CONSTRAINT schedule_occurrences_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.schema_versions
    ADD CONSTRAINT schema_versions_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.schema_versions
    ADD CONSTRAINT schema_versions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.self_healing_scans
    ADD CONSTRAINT self_healing_scans_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.sessions
    ADD CONSTRAINT sessions_auth_identity_id_auth_identities_id_fk FOREIGN KEY (auth_identity_id) REFERENCES subkit.auth_identities(id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.sessions
    ADD CONSTRAINT sessions_installation_id_cockpit_installations_id_fk FOREIGN KEY (installation_id) REFERENCES subkit.cockpit_installations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.sessions
    ADD CONSTRAINT sessions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.skill_candidate_evidence
    ADD CONSTRAINT skill_candidate_evidence_skill_candidate_id_skill_candidates_id FOREIGN KEY (skill_candidate_id) REFERENCES subkit.skill_candidates(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.skill_candidates
    ADD CONSTRAINT skill_candidates_promoted_skill_id_skills_id_fk FOREIGN KEY (promoted_skill_id) REFERENCES subkit.skills(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.skill_candidates
    ADD CONSTRAINT skill_candidates_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.skill_effectiveness
    ADD CONSTRAINT skill_effectiveness_intake_proposal_id_intake_proposals_id_fk FOREIGN KEY (intake_proposal_id) REFERENCES subkit.intake_proposals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.skill_effectiveness
    ADD CONSTRAINT skill_effectiveness_skill_candidate_id_skill_candidates_id_fk FOREIGN KEY (skill_candidate_id) REFERENCES subkit.skill_candidates(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.skill_effectiveness
    ADD CONSTRAINT skill_effectiveness_skill_id_skills_id_fk FOREIGN KEY (skill_id) REFERENCES subkit.skills(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.skill_effectiveness
    ADD CONSTRAINT skill_effectiveness_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.skills
    ADD CONSTRAINT skills_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.subscriptions
    ADD CONSTRAINT subscriptions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.system_accounts
    ADD CONSTRAINT system_accounts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.task_grants
    ADD CONSTRAINT task_grants_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES subkit.tasks(id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.task_grants
    ADD CONSTRAINT task_grants_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.task_runs
    ADD CONSTRAINT task_runs_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.task_runs
    ADD CONSTRAINT task_runs_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES subkit.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.task_runs
    ADD CONSTRAINT task_runs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.tasks
    ADD CONSTRAINT tasks_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.tenant_branding
    ADD CONSTRAINT tenant_branding_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.tenant_erasure_states
    ADD CONSTRAINT tenant_erasure_states_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.tenant_skill_overrides
    ADD CONSTRAINT tenant_skill_overrides_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.tenants
    ADD CONSTRAINT tenants_owner_identity_id_auth_identities_id_fk FOREIGN KEY (owner_identity_id) REFERENCES subkit.auth_identities(id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.tool_approval_rules
    ADD CONSTRAINT tool_approval_rules_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.tool_approval_rules
    ADD CONSTRAINT tool_approval_rules_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.tool_approvals
    ADD CONSTRAINT tool_approvals_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.transactional_mail_receipts
    ADD CONSTRAINT transactional_mail_receipts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.transactional_mail_receipts
    ADD CONSTRAINT transactional_mail_receipts_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.usage_events
    ADD CONSTRAINT usage_events_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_identities
    ADD CONSTRAINT user_identities_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_identities
    ADD CONSTRAINT user_identities_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_invites
    ADD CONSTRAINT user_invites_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_invites
    ADD CONSTRAINT user_invites_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_llm_settings
    ADD CONSTRAINT user_llm_settings_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_setup_preferences
    ADD CONSTRAINT user_setup_preferences_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.user_setup_preferences
    ADD CONSTRAINT user_setup_preferences_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.users
    ADD CONSTRAINT users_auth_identity_id_auth_identities_id_fk FOREIGN KEY (auth_identity_id) REFERENCES subkit.auth_identities(id);
--> statement-breakpoint
ALTER TABLE ONLY subkit.users
    ADD CONSTRAINT users_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.vault_items
    ADD CONSTRAINT vault_items_connection_id_outbound_connections_id_fk FOREIGN KEY (connection_id) REFERENCES subkit.outbound_connections(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.vault_items
    ADD CONSTRAINT vault_items_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES subkit.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.vault_items
    ADD CONSTRAINT vault_items_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.vault_items
    ADD CONSTRAINT vault_items_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.vendor_recipe_overrides
    ADD CONSTRAINT vendor_recipe_overrides_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.webhook_replay_seen
    ADD CONSTRAINT webhook_replay_seen_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.webhook_replay_seen
    ADD CONSTRAINT webhook_replay_seen_webhook_id_webhooks_inbound_id_fk FOREIGN KEY (webhook_id) REFERENCES subkit.webhooks_inbound(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.webhooks_inbound
    ADD CONSTRAINT webhooks_inbound_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.webhooks_inbound
    ADD CONSTRAINT webhooks_inbound_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.webhooks_outbound
    ADD CONSTRAINT webhooks_outbound_subscription_id_subscriptions_id_fk FOREIGN KEY (subscription_id) REFERENCES subkit.subscriptions(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.webhooks_outbound
    ADD CONSTRAINT webhooks_outbound_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_execution_authorities
    ADD CONSTRAINT workflow_authorities_exact_version_fk FOREIGN KEY (tenant_id, workflow_id, workflow_version_id) REFERENCES subkit.workflow_versions(tenant_id, workflow_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_execution_authorities
    ADD CONSTRAINT workflow_authorities_inherited_from_fk FOREIGN KEY (tenant_id, inherited_from) REFERENCES subkit.workflow_execution_authorities(tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_execution_authorities
    ADD CONSTRAINT workflow_authorities_tenant_workflow_fk FOREIGN KEY (tenant_id, workflow_id) REFERENCES subkit.workflows(tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_authority_pair_requests
    ADD CONSTRAINT workflow_authority_pair_requests_first_approver_id_users_id_fk FOREIGN KEY (first_approver_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_authority_pair_requests
    ADD CONSTRAINT workflow_authority_pair_requests_second_approver_id_users_id_fk FOREIGN KEY (second_approver_id) REFERENCES subkit.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_authority_pair_requests
    ADD CONSTRAINT workflow_authority_pair_requests_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_autoheal_policies
    ADD CONSTRAINT workflow_autoheal_policies_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_autoheal_policies
    ADD CONSTRAINT workflow_autoheal_policies_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_execution_authorities
    ADD CONSTRAINT workflow_execution_authorities_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_review_receipts
    ADD CONSTRAINT workflow_review_receipts_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES subkit.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_review_receipts
    ADD CONSTRAINT workflow_review_receipts_tenant_authority_fk FOREIGN KEY (tenant_id, authority_id) REFERENCES subkit.workflow_execution_authorities(tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_review_receipts
    ADD CONSTRAINT workflow_review_receipts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_review_receipts
    ADD CONSTRAINT workflow_review_receipts_tenant_workflow_fk FOREIGN KEY (tenant_id, workflow_id) REFERENCES subkit.workflows(tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_review_receipts
    ADD CONSTRAINT workflow_review_receipts_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_run_state
    ADD CONSTRAINT workflow_run_state_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_run_state
    ADD CONSTRAINT workflow_run_state_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_signals
    ADD CONSTRAINT workflow_signals_execution_id_executions_id_fk FOREIGN KEY (execution_id) REFERENCES subkit.executions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_signals
    ADD CONSTRAINT workflow_signals_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_versions
    ADD CONSTRAINT workflow_versions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_versions
    ADD CONSTRAINT workflow_versions_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_waits
    ADD CONSTRAINT workflow_waits_execution_id_executions_id_fk FOREIGN KEY (execution_id) REFERENCES subkit.executions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_waits
    ADD CONSTRAINT workflow_waits_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflow_waits
    ADD CONSTRAINT workflow_waits_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflows_schedules
    ADD CONSTRAINT workflows_schedules_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflows_schedules
    ADD CONSTRAINT workflows_schedules_workflow_id_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES subkit.workflows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY subkit.workflows
    ADD CONSTRAINT workflows_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
--> statement-breakpoint
REVOKE ALL ON FUNCTION subkit.vault_maintenance_apply(p_operation uuid, p_page_sha256 text, p_rows subkit.vault_cipher_replacement[], p_finish boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION subkit.vault_maintenance_authorize() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION subkit.vault_maintenance_snapshot(p_operation uuid, p_expected_epoch bigint, p_target_key_sha256 text, p_evidence_sha256 text, p_after_name text, p_after_version integer, p_limit integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION subkit.vault_maintenance_status() FROM PUBLIC;
--> statement-breakpoint
INSERT INTO "scheduler_sweep_cursors" ("producer") VALUES ('catalog'), ('docs'), ('workflow-cron'), ('drift'), ('reauth'), ('endpoint-contract'), ('knowledge'), ('skill'), ('task');
