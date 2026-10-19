CREATE OR REPLACE FUNCTION subkit.hosted_control_receipt_id(p_tenant uuid,p_type text,p_resource uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT overlay(overlay(substr(encode(public.digest('hosted-resource-control:'||p_tenant::text||':'||p_type||':'||p_resource::text,'sha256'),'hex'),1,32) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
$$
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_content_quota_terminal(p_table text,j jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(CASE WHEN p_table='executions' THEN
  j->>'status'='failed' AND j->>'finished_at' IS NOT NULL AND j#>>'{failure,error_code}' IN ('hosted_storage_quota_exhausted','hosted_resource_count_exhausted')
  AND j->'failure'=jsonb_build_object('step_id',NULL,'error_code',j#>>'{failure,error_code}','error_message','Workspace resource allowance exhausted.')
 WHEN p_table='mcp_tasks' THEN
  j->>'failure_reason' IN ('hosted_storage_quota_exhausted','hosted_resource_count_exhausted') AND j->>'result' IS NULL AND j->>'cancelled_at' IS NULL
 ELSE false END,false)
$$
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_singleton_control_receipt(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE kind text:=j->>'resource_type'; resource uuid; tenant uuid;
BEGIN
 IF NOT COALESCE(j->>'resource_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false) THEN RETURN false; END IF;
 resource:=(j->>'resource_id')::uuid;tenant:=(j->>'tenant_id')::uuid;
 IF (j->>'id')::uuid<>subkit.hosted_control_receipt_id(tenant,kind,resource) OR j->>'before' IS NOT NULL OR j->>'after' IS NOT NULL OR j->>'ip' IS NOT NULL OR j->>'user_agent' IS NOT NULL OR COALESCE(length(j->>'trace_id'),0)>128 THEN RETURN false; END IF;
 IF kind IN ('execution','mcp_task') THEN
  RETURN COALESCE(j->>'actor_type'='system' AND j->>'actor_id' IS NULL AND j->>'result'='denied'
   AND j->>'reason' IN ('hosted_storage_quota_exhausted','hosted_resource_count_exhausted')
   AND j->'metadata'=jsonb_build_object('code',j->>'reason')
   AND j->>'action'=CASE kind WHEN 'execution' THEN 'execution.failed' ELSE 'conversation.turn_failed' END,false);
 END IF;
 IF kind='hosted_storage_object' THEN
  RETURN COALESCE(j->>'actor_type'='user' AND j->>'actor_id' IS NOT NULL AND j->>'result'='success'
   AND j->>'action'='hosted_storage_object.reconciled' AND j->>'reason'='operator_reviewed_remote_upload_stop'
   AND (j->'metadata')-ARRAY['storage_namespace','evidence_sha256','operator_tenant_id']='{}'::jsonb
   AND j#>>'{metadata,storage_namespace}' ~ '^[0-9a-f]{64}$' AND j#>>'{metadata,evidence_sha256}' ~ '^[0-9a-f]{64}$'
   AND j#>>'{metadata,operator_tenant_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false);
 END IF;
 RETURN false;
END $$
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_singleton_control_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean:=false;
BEGIN
 IF NOT subkit.hosted_singleton_control_receipt(to_jsonb(NEW)) THEN RETURN NEW; END IF;
 IF NEW.resource_type='execution' THEN
  PERFORM 1 FROM subkit.executions e WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.resource_id::uuid AND subkit.hosted_content_quota_terminal('executions',to_jsonb(e)) AND e.failure->>'error_code'=NEW.reason FOR KEY SHARE;
  valid:=FOUND;
 ELSIF NEW.resource_type='mcp_task' THEN
  PERFORM 1 FROM subkit.mcp_tasks t WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.resource_id::uuid AND subkit.hosted_content_quota_terminal('mcp_tasks',to_jsonb(t)) AND t.failure_reason=NEW.reason FOR KEY SHARE;
  valid:=FOUND;
 ELSE
  PERFORM 1 FROM subkit.hosted_storage_objects o WHERE o.tenant_id=NEW.tenant_id AND o.id=NEW.resource_id::uuid AND o.state='pending' AND o.storage_namespace=NEW.metadata->>'storage_namespace' FOR KEY SHARE;
  valid:=FOUND AND EXISTS(SELECT 1 FROM subkit.users u JOIN subkit.tenants t ON t.id=u.tenant_id WHERE u.id=NEW.actor_id AND t.id=(NEW.metadata->>'operator_tenant_id')::uuid AND t.is_operator AND t.status='active' AND t.deleted_at IS NULL AND u.status='active' AND u.deleted_at IS NULL);
 END IF;
 IF NOT valid THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_quota_control_receipt_invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hosted_singleton_control_guard BEFORE INSERT OR UPDATE ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.hosted_singleton_control_guard()
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_terminal_receipt_required() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER hosted_terminal_receipt_required AFTER INSERT OR UPDATE ON subkit.executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION subkit.hosted_terminal_receipt_required();
CREATE CONSTRAINT TRIGGER hosted_terminal_receipt_required AFTER INSERT OR UPDATE ON subkit.mcp_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION subkit.hosted_terminal_receipt_required()
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_apply_usage(p_tenant uuid,p_resource text,p_bytes bigint,p_count bigint) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
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
END $$;
CREATE OR REPLACE FUNCTION subkit.hosted_initialize_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.origin='self_service' THEN INSERT INTO subkit.hosted_tenant_usage(tenant_id) VALUES(NEW.id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hosted_initialize_usage AFTER INSERT ON subkit.tenants FOR EACH ROW EXECUTE FUNCTION subkit.hosted_initialize_usage();
INSERT INTO subkit.hosted_tenant_usage(tenant_id) SELECT id FROM subkit.tenants WHERE origin='self_service' ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_api_keys() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_api_keys AFTER INSERT OR UPDATE OR DELETE ON subkit."api_keys" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_api_keys();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['api_keys'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."prefix"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."allowed_workflows"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."allowed_connectors"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."api_keys" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_audit_log() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
 AND (NOT (OLD.metadata ? 'auth_via') OR OLD.metadata->>'auth_via'='token_exchange')
 AND (
 ((CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'execution_privacy'='sensitive' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT ((CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' ? 'execution_id') OR (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (OLD.reason IS NULL OR OLD.reason='sensitive_execution') AND ((OLD.resource_type='hosted_work' AND OLD.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (OLD.resource_type='llm_budget' AND OLD.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (OLD.resource_type='hosted_work' AND OLD.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE((CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via','{}'::jsonb)='{}'::jsonb
 AND (OLD.reason IS NULL OR OLD.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (OLD.resource_type='llm_budget' AND OLD.reason IS NULL AND
 ((OLD.action='llm.budget.reserved' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (OLD.action='llm.budget.settled' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'state' IN ('settled','released','reconciliation_required'))))
 OR (OLD.resource_type='tenant' AND OLD.resource_id=OLD.tenant_id::text AND (
 (OLD.action='tenant.deletion_requested' AND OLD.reason IS NULL AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - 'deletion_scheduled_for'='{}'::jsonb AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (OLD.action='tenant.restored' AND OLD.reason IS NULL AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'='{"via":"verified_identity_recovery"}'::jsonb)
 OR (OLD.action='tenant.updated' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'source'='tenant_erasure' AND (
 (OLD.reason IS NULL AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - ARRAY['source','stage','attempt']='{}'::jsonb AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT ((CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' ? 'attempt') OR (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (OLD.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'='{"source":"tenant_erasure"}'::jsonb)))
 OR (OLD.action='tenant.deleted' AND OLD.reason IS NULL AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (OLD.action='tenant.updated' AND OLD.reason IS NULL AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'source'='tenant_erasure_runtime_cleanup' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'revisions' ~ '^[0-9]{1,10}$' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'secret_versions' ~ '^[0-9]{1,10}$' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'restart_requests' ~ '^[0-9]{1,10}$' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (OLD.resource_type='hosted_work' AND OLD.action='hosted_work.reconciled' AND OLD.reason='operator_reviewed_owner_stop' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))),false) THEN 0 ELSE COALESCE(octet_length(convert_to(OLD."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."resource_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."resource_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."trace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."ip"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."user_agent"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."before"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."after"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."metadata"::text,'UTF8')),0)::bigint END);v_count:=v_count-(CASE WHEN COALESCE((subkit.hosted_singleton_control_receipt(to_jsonb(OLD)) OR (
 OLD.actor_type IN ('system','user')
 AND OLD.before IS NULL AND OLD.after IS NULL AND OLD.user_agent IS NULL
 AND OLD.resource_id ~ '^[0-9a-f-]{36}$'
 AND COALESCE(length(OLD.ip),0)<=64 AND COALESCE(length(OLD.trace_id),0)<=128
 AND (NOT (OLD.metadata ? 'auth_via') OR OLD.metadata->>'auth_via'='token_exchange')
 AND (
 ((CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'execution_privacy'='sensitive' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT ((CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' ? 'execution_id') OR (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (OLD.reason IS NULL OR OLD.reason='sensitive_execution') AND ((OLD.resource_type='hosted_work' AND OLD.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (OLD.resource_type='llm_budget' AND OLD.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (OLD.resource_type='hosted_work' AND OLD.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE((CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via','{}'::jsonb)='{}'::jsonb
 AND (OLD.reason IS NULL OR OLD.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (OLD.resource_type='llm_budget' AND OLD.reason IS NULL AND
 ((OLD.action='llm.budget.reserved' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (OLD.action='llm.budget.settled' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'state' IN ('settled','released','reconciliation_required'))))
 OR (OLD.resource_type='tenant' AND OLD.resource_id=OLD.tenant_id::text AND (
 (OLD.action='tenant.deletion_requested' AND OLD.reason IS NULL AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - 'deletion_scheduled_for'='{}'::jsonb AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (OLD.action='tenant.restored' AND OLD.reason IS NULL AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'='{"via":"verified_identity_recovery"}'::jsonb)
 OR (OLD.action='tenant.updated' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'source'='tenant_erasure' AND (
 (OLD.reason IS NULL AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - ARRAY['source','stage','attempt']='{}'::jsonb AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT ((CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' ? 'attempt') OR (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (OLD.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'='{"source":"tenant_erasure"}'::jsonb)))
 OR (OLD.action='tenant.deleted' AND OLD.reason IS NULL AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (OLD.action='tenant.updated' AND OLD.reason IS NULL AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'source'='tenant_erasure_runtime_cleanup' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'revisions' ~ '^[0-9]{1,10}$' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'secret_versions' ~ '^[0-9]{1,10}$' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'restart_requests' ~ '^[0-9]{1,10}$' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (OLD.resource_type='hosted_work' AND OLD.action='hosted_work.reconciled' AND OLD.reason='operator_reviewed_owner_stop' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via' - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN OLD.metadata->>'via'='token_exchange' THEN OLD.metadata-'via' ELSE OLD.metadata END)-'auth_via'->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))),false) THEN 0 ELSE 1 END); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(CASE WHEN COALESCE((subkit.hosted_singleton_control_receipt(to_jsonb(NEW)) OR (
 NEW.actor_type IN ('system','user')
 AND NEW.before IS NULL AND NEW.after IS NULL AND NEW.user_agent IS NULL
 AND NEW.resource_id ~ '^[0-9a-f-]{36}$'
 AND COALESCE(length(NEW.ip),0)<=64 AND COALESCE(length(NEW.trace_id),0)<=128
 AND (NOT (NEW.metadata ? 'auth_via') OR NEW.metadata->>'auth_via'='token_exchange')
 AND (
 ((CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'execution_privacy'='sensitive' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT ((CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' ? 'execution_id') OR (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (NEW.reason IS NULL OR NEW.reason='sensitive_execution') AND ((NEW.resource_type='hosted_work' AND NEW.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (NEW.resource_type='llm_budget' AND NEW.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (NEW.resource_type='hosted_work' AND NEW.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE((CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via','{}'::jsonb)='{}'::jsonb
 AND (NEW.reason IS NULL OR NEW.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (NEW.resource_type='llm_budget' AND NEW.reason IS NULL AND
 ((NEW.action='llm.budget.reserved' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (NEW.action='llm.budget.settled' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'state' IN ('settled','released','reconciliation_required'))))
 OR (NEW.resource_type='tenant' AND NEW.resource_id=NEW.tenant_id::text AND (
 (NEW.action='tenant.deletion_requested' AND NEW.reason IS NULL AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - 'deletion_scheduled_for'='{}'::jsonb AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (NEW.action='tenant.restored' AND NEW.reason IS NULL AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'='{"via":"verified_identity_recovery"}'::jsonb)
 OR (NEW.action='tenant.updated' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'source'='tenant_erasure' AND (
 (NEW.reason IS NULL AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - ARRAY['source','stage','attempt']='{}'::jsonb AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT ((CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' ? 'attempt') OR (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (NEW.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'='{"source":"tenant_erasure"}'::jsonb)))
 OR (NEW.action='tenant.deleted' AND NEW.reason IS NULL AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (NEW.action='tenant.updated' AND NEW.reason IS NULL AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'source'='tenant_erasure_runtime_cleanup' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'revisions' ~ '^[0-9]{1,10}$' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'secret_versions' ~ '^[0-9]{1,10}$' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'restart_requests' ~ '^[0-9]{1,10}$' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (NEW.resource_type='hosted_work' AND NEW.action='hosted_work.reconciled' AND NEW.reason='operator_reviewed_owner_stop' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))),false) THEN 0 ELSE COALESCE(octet_length(convert_to(NEW."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."resource_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."resource_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."trace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."ip"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."user_agent"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."before"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."after"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."metadata"::text,'UTF8')),0)::bigint END);v_count:=v_count+(CASE WHEN COALESCE((subkit.hosted_singleton_control_receipt(to_jsonb(NEW)) OR (
 NEW.actor_type IN ('system','user')
 AND NEW.before IS NULL AND NEW.after IS NULL AND NEW.user_agent IS NULL
 AND NEW.resource_id ~ '^[0-9a-f-]{36}$'
 AND COALESCE(length(NEW.ip),0)<=64 AND COALESCE(length(NEW.trace_id),0)<=128
 AND (NOT (NEW.metadata ? 'auth_via') OR NEW.metadata->>'auth_via'='token_exchange')
 AND (
 ((CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'execution_privacy'='sensitive' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT ((CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' ? 'execution_id') OR (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (NEW.reason IS NULL OR NEW.reason='sensitive_execution') AND ((NEW.resource_type='hosted_work' AND NEW.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (NEW.resource_type='llm_budget' AND NEW.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (NEW.resource_type='hosted_work' AND NEW.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE((CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via','{}'::jsonb)='{}'::jsonb
 AND (NEW.reason IS NULL OR NEW.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (NEW.resource_type='llm_budget' AND NEW.reason IS NULL AND
 ((NEW.action='llm.budget.reserved' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (NEW.action='llm.budget.settled' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'state' IN ('settled','released','reconciliation_required'))))
 OR (NEW.resource_type='tenant' AND NEW.resource_id=NEW.tenant_id::text AND (
 (NEW.action='tenant.deletion_requested' AND NEW.reason IS NULL AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - 'deletion_scheduled_for'='{}'::jsonb AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (NEW.action='tenant.restored' AND NEW.reason IS NULL AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'='{"via":"verified_identity_recovery"}'::jsonb)
 OR (NEW.action='tenant.updated' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'source'='tenant_erasure' AND (
 (NEW.reason IS NULL AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - ARRAY['source','stage','attempt']='{}'::jsonb AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT ((CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' ? 'attempt') OR (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (NEW.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'='{"source":"tenant_erasure"}'::jsonb)))
 OR (NEW.action='tenant.deleted' AND NEW.reason IS NULL AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (NEW.action='tenant.updated' AND NEW.reason IS NULL AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'source'='tenant_erasure_runtime_cleanup' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'revisions' ~ '^[0-9]{1,10}$' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'secret_versions' ~ '^[0-9]{1,10}$' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'restart_requests' ~ '^[0-9]{1,10}$' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (NEW.resource_type='hosted_work' AND NEW.action='hosted_work.reconciled' AND NEW.reason='operator_reviewed_owner_stop' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via' - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN NEW.metadata->>'via'='token_exchange' THEN NEW.metadata-'via' ELSE NEW.metadata END)-'auth_via'->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))),false) THEN 0 ELSE 1 END); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'audit_log',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hosted_meter_audit_log AFTER INSERT OR UPDATE OR DELETE ON subkit."audit_log" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_audit_log();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['audit_log'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(CASE WHEN COALESCE((subkit.hosted_singleton_control_receipt(to_jsonb(r)) OR (
 r.actor_type IN ('system','user')
 AND r.before IS NULL AND r.after IS NULL AND r.user_agent IS NULL
 AND r.resource_id ~ '^[0-9a-f-]{36}$'
 AND COALESCE(length(r.ip),0)<=64 AND COALESCE(length(r.trace_id),0)<=128
 AND (NOT (r.metadata ? 'auth_via') OR r.metadata->>'auth_via'='token_exchange')
 AND (
 ((CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'execution_privacy'='sensitive' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT ((CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' ? 'execution_id') OR (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (r.reason IS NULL OR r.reason='sensitive_execution') AND ((r.resource_type='hosted_work' AND r.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (r.resource_type='llm_budget' AND r.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (r.resource_type='hosted_work' AND r.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE((CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via','{}'::jsonb)='{}'::jsonb
 AND (r.reason IS NULL OR r.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (r.resource_type='llm_budget' AND r.reason IS NULL AND
 ((r.action='llm.budget.reserved' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (r.action='llm.budget.settled' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'state' IN ('settled','released','reconciliation_required'))))
 OR (r.resource_type='tenant' AND r.resource_id=r.tenant_id::text AND (
 (r.action='tenant.deletion_requested' AND r.reason IS NULL AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - 'deletion_scheduled_for'='{}'::jsonb AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (r.action='tenant.restored' AND r.reason IS NULL AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'='{"via":"verified_identity_recovery"}'::jsonb)
 OR (r.action='tenant.updated' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'source'='tenant_erasure' AND (
 (r.reason IS NULL AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - ARRAY['source','stage','attempt']='{}'::jsonb AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT ((CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' ? 'attempt') OR (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (r.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'='{"source":"tenant_erasure"}'::jsonb)))
 OR (r.action='tenant.deleted' AND r.reason IS NULL AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (r.action='tenant.updated' AND r.reason IS NULL AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'source'='tenant_erasure_runtime_cleanup' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'revisions' ~ '^[0-9]{1,10}$' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'secret_versions' ~ '^[0-9]{1,10}$' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'restart_requests' ~ '^[0-9]{1,10}$' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (r.resource_type='hosted_work' AND r.action='hosted_work.reconciled' AND r.reason='operator_reviewed_owner_stop' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))),false) THEN 0 ELSE COALESCE(octet_length(convert_to(r."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."resource_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."resource_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."trace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."ip"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."user_agent"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."before"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."after"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."metadata"::text,'UTF8')),0)::bigint END),0)::bigint AS bytes,sum(CASE WHEN COALESCE((subkit.hosted_singleton_control_receipt(to_jsonb(r)) OR (
 r.actor_type IN ('system','user')
 AND r.before IS NULL AND r.after IS NULL AND r.user_agent IS NULL
 AND r.resource_id ~ '^[0-9a-f-]{36}$'
 AND COALESCE(length(r.ip),0)<=64 AND COALESCE(length(r.trace_id),0)<=128
 AND (NOT (r.metadata ? 'auth_via') OR r.metadata->>'auth_via'='token_exchange')
 AND (
 ((CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'execution_privacy'='sensitive' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT ((CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' ? 'execution_id') OR (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (r.reason IS NULL OR r.reason='sensitive_execution') AND ((r.resource_type='hosted_work' AND r.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (r.resource_type='llm_budget' AND r.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (r.resource_type='hosted_work' AND r.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE((CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via','{}'::jsonb)='{}'::jsonb
 AND (r.reason IS NULL OR r.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (r.resource_type='llm_budget' AND r.reason IS NULL AND
 ((r.action='llm.budget.reserved' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (r.action='llm.budget.settled' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'currency'='USD' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'state' IN ('settled','released','reconciliation_required'))))
 OR (r.resource_type='tenant' AND r.resource_id=r.tenant_id::text AND (
 (r.action='tenant.deletion_requested' AND r.reason IS NULL AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - 'deletion_scheduled_for'='{}'::jsonb AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (r.action='tenant.restored' AND r.reason IS NULL AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'='{"via":"verified_identity_recovery"}'::jsonb)
 OR (r.action='tenant.updated' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'source'='tenant_erasure' AND (
 (r.reason IS NULL AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - ARRAY['source','stage','attempt']='{}'::jsonb AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT ((CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' ? 'attempt') OR (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (r.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'='{"source":"tenant_erasure"}'::jsonb)))
 OR (r.action='tenant.deleted' AND r.reason IS NULL AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (r.action='tenant.updated' AND r.reason IS NULL AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'source'='tenant_erasure_runtime_cleanup' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'revisions' ~ '^[0-9]{1,10}$' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'secret_versions' ~ '^[0-9]{1,10}$' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'restart_requests' ~ '^[0-9]{1,10}$' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (r.resource_type='hosted_work' AND r.action='hosted_work.reconciled' AND r.reason='operator_reviewed_owner_stop' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via' - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND (CASE WHEN r.metadata->>'via'='token_exchange' THEN r.metadata-'via' ELSE r.metadata END)-'auth_via'->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))),false) THEN 0 ELSE 1 END)::bigint AS count FROM subkit."audit_log" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_auth_provider_configs() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_auth_provider_configs AFTER INSERT OR UPDATE OR DELETE ON subkit."auth_provider_configs" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_auth_provider_configs();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['auth_provider_configs'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."provider"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."config_ciphertext"),0)::bigint + COALESCE(octet_length(r."config_iv"),0)::bigint + COALESCE(octet_length(r."config_auth_tag"),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."auth_provider_configs" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_catalog_categories() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_catalog_categories AFTER INSERT OR UPDATE OR DELETE ON subkit."catalog_categories" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_catalog_categories();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['catalog_categories'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."purpose"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."purpose_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."aliases"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."redirect_to"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."catalog_categories" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_chat_deliveries() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_chat_deliveries AFTER INSERT OR UPDATE OR DELETE ON subkit."chat_deliveries" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_chat_deliveries();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['chat_deliveries'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."thread_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."payload"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."status"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."chat_deliveries" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_chat_identities() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_chat_identities AFTER INSERT OR UPDATE OR DELETE ON subkit."chat_identities" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_chat_identities();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['chat_identities'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."platform"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."platform_user_id"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."chat_identities" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_chat_sessions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_chat_sessions AFTER INSERT OR UPDATE OR DELETE ON subkit."chat_sessions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_chat_sessions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['chat_sessions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."thread_id"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."chat_sessions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_chat_workspaces() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_chat_workspaces AFTER INSERT OR UPDATE OR DELETE ON subkit."chat_workspaces" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_chat_workspaces();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['chat_workspaces'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."default_channel"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."bot_ciphertext"),0)::bigint + COALESCE(octet_length(r."bot_iv"),0)::bigint + COALESCE(octet_length(r."bot_auth_tag"),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."chat_workspaces" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_cli_notification_inbox() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_cli_notification_inbox AFTER INSERT OR UPDATE OR DELETE ON subkit."cli_notification_inbox" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_cli_notification_inbox();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['cli_notification_inbox'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."event_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."event_payload"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."resource_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."resource_id"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."cli_notification_inbox" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_cli_notification_inbox_reads() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_cli_notification_inbox_reads AFTER INSERT OR UPDATE OR DELETE ON subkit."cli_notification_inbox_reads" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_cli_notification_inbox_reads();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['cli_notification_inbox_reads'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(0::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."cli_notification_inbox_reads" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_connector_document_chunks() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_connector_document_chunks AFTER INSERT OR UPDATE OR DELETE ON subkit."connector_document_chunks" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_document_chunks();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['connector_document_chunks'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."tsv"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."embedding"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."embedding_model"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."connector_document_chunks" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_connector_documents() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_connector_documents AFTER INSERT OR UPDATE OR DELETE ON subkit."connector_documents" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_documents();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['connector_documents'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."source_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."version"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."connector_documents" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_connector_endpoint_schemas() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_connector_endpoint_schemas AFTER INSERT OR UPDATE OR DELETE ON subkit."connector_endpoint_schemas" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_endpoint_schemas();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['connector_endpoint_schemas'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."method"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."request_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."query_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."response_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."expected_statuses"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."source"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."connector_endpoint_schemas" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_connector_environments() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_connector_environments AFTER INSERT OR UPDATE OR DELETE ON subkit."connector_environments" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_environments();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['connector_environments'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."overrides"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."connector_environments" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_connector_mcp_sessions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_connector_mcp_sessions AFTER INSERT OR UPDATE OR DELETE ON subkit."connector_mcp_sessions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_mcp_sessions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['connector_mcp_sessions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."negotiated_protocol_version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."server_capabilities"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."tools_manifest_hash"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."connector_mcp_sessions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_connector_promotions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_connector_promotions AFTER INSERT OR UPDATE OR DELETE ON subkit."connector_promotions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_promotions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['connector_promotions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."idempotency_key_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."request_fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."strategy"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."response"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."connector_promotions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_connector_template_credentials() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."template_slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."ciphertext"),0)::bigint + COALESCE(octet_length(OLD."iv"),0)::bigint + COALESCE(octet_length(OLD."auth_tag"),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."template_slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."ciphertext"),0)::bigint + COALESCE(octet_length(NEW."iv"),0)::bigint + COALESCE(octet_length(NEW."auth_tag"),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'connector_template_credentials',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hosted_meter_connector_template_credentials AFTER INSERT OR UPDATE OR DELETE ON subkit."connector_template_credentials" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_template_credentials();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['connector_template_credentials'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."template_slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."ciphertext"),0)::bigint + COALESCE(octet_length(r."iv"),0)::bigint + COALESCE(octet_length(r."auth_tag"),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."connector_template_credentials" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_connector_templates() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_connector_templates AFTER INSERT OR UPDATE OR DELETE ON subkit."connector_templates" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connector_templates();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['connector_templates'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."driver"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."auth_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."oauth"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."default_skill"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."ingestion_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."ingestion_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."icon"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."aliases"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."setup_instructions"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."auth_options"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."url_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."keywords"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."inline_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."probe_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."credential_hints"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."base_url_options"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."pagination_defaults"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."capabilities"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."connector_templates" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_connectors() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_connectors AFTER INSERT OR UPDATE OR DELETE ON subkit."connectors" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_connectors();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['connectors'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."driver"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."config"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."dsn"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."operator_quirks"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."self_description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."template_slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."template_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."template_snapshot"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."auto_refresh_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."circuit_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."auth_failed_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."health_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."health_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."health_error_code"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."successor_uri"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."connectors" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_conversation_draft_snapshots() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_conversation_draft_snapshots AFTER INSERT OR UPDATE OR DELETE ON subkit."conversation_draft_snapshots" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_draft_snapshots();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['conversation_draft_snapshots'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."draft"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."label"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."conversation_draft_snapshots" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_conversation_drafts() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_conversation_drafts AFTER INSERT OR UPDATE OR DELETE ON subkit."conversation_drafts" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_drafts();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['conversation_drafts'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."ordinal"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."snapshot"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."conversation_drafts" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_conversation_elicitations() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_conversation_elicitations AFTER INSERT OR UPDATE OR DELETE ON subkit."conversation_elicitations" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_elicitations();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['conversation_elicitations'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."tool_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."summary"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."output"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."delivery_last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."decision_reason"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."conversation_elicitations" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_conversation_hidden() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_conversation_hidden AFTER INSERT OR UPDATE OR DELETE ON subkit."conversation_hidden" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_hidden();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['conversation_hidden'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(0::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."conversation_hidden" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_conversation_messages() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_conversation_messages AFTER INSERT OR UPDATE OR DELETE ON subkit."conversation_messages" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_messages();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['conversation_messages'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."model"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."conversation_messages" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_conversation_tool_calls() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_conversation_tool_calls AFTER INSERT OR UPDATE OR DELETE ON subkit."conversation_tool_calls" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversation_tool_calls();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['conversation_tool_calls'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."tool"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."output"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."confirmation_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."outcome"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."confirmation_data"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."interaction_log"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."conversation_tool_calls" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_conversations() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_conversations AFTER INSERT OR UPDATE OR DELETE ON subkit."conversations" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_conversations();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['conversations'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."draft"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."last_turn_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."model"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."memory"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."loaded_skills"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."tool_policies"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."topic_embedding"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."topic_embedding_model"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."origin_client"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."surface"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."conversations" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_credentials() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."verified_identity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."ciphertext"),0)::bigint + COALESCE(octet_length(OLD."iv"),0)::bigint + COALESCE(octet_length(OLD."auth_tag"),0)::bigint + COALESCE(octet_length(OLD."oauth2_refresh_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."oauth2_refresh_iv"),0)::bigint + COALESCE(octet_length(OLD."oauth2_refresh_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(OLD."granted_scopes"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."verified_identity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."ciphertext"),0)::bigint + COALESCE(octet_length(NEW."iv"),0)::bigint + COALESCE(octet_length(NEW."auth_tag"),0)::bigint + COALESCE(octet_length(NEW."oauth2_refresh_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."oauth2_refresh_iv"),0)::bigint + COALESCE(octet_length(NEW."oauth2_refresh_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(NEW."granted_scopes"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'credentials',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hosted_meter_credentials AFTER INSERT OR UPDATE OR DELETE ON subkit."credentials" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_credentials();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['credentials'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."verified_identity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."ciphertext"),0)::bigint + COALESCE(octet_length(r."iv"),0)::bigint + COALESCE(octet_length(r."auth_tag"),0)::bigint + COALESCE(octet_length(r."oauth2_refresh_ciphertext"),0)::bigint + COALESCE(octet_length(r."oauth2_refresh_iv"),0)::bigint + COALESCE(octet_length(r."oauth2_refresh_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(r."granted_scopes"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."credentials" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_deliveries() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_deliveries AFTER INSERT OR UPDATE OR DELETE ON subkit."deliveries" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_deliveries();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['deliveries'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."classification"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."terminal_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."request_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."event_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."target_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."response_body"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."deliveries" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_discovery_artifacts() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_discovery_artifacts AFTER INSERT OR UPDATE OR DELETE ON subkit."discovery_artifacts" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_discovery_artifacts();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['discovery_artifacts'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."draft"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."evidence"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."materialized_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."materialized_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."rejection_reason"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."discovery_artifacts" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_discovery_files() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_discovery_files AFTER INSERT OR UPDATE OR DELETE ON subkit."discovery_files" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_discovery_files();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['discovery_files'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."filename"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."mime_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."format"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."fingerprint"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."discovery_files" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_discovery_runs() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_discovery_runs AFTER INSERT OR UPDATE OR DELETE ON subkit."discovery_runs" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_discovery_runs();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['discovery_runs'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."label"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."token_usage"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."error"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."discovery_runs" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_end_user_credentials() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."enduser_ref"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."ciphertext"),0)::bigint + COALESCE(octet_length(OLD."iv"),0)::bigint + COALESCE(octet_length(OLD."auth_tag"),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."enduser_ref"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."ciphertext"),0)::bigint + COALESCE(octet_length(NEW."iv"),0)::bigint + COALESCE(octet_length(NEW."auth_tag"),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'end_user_credentials',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hosted_meter_end_user_credentials AFTER INSERT OR UPDATE OR DELETE ON subkit."end_user_credentials" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_end_user_credentials();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['end_user_credentials'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."enduser_ref"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."ciphertext"),0)::bigint + COALESCE(octet_length(r."iv"),0)::bigint + COALESCE(octet_length(r."auth_tag"),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."end_user_credentials" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_events() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_events AFTER INSERT OR UPDATE OR DELETE ON subkit."events" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_events();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['events'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."channel"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."payload"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."events" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_execution_fixtures() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_execution_fixtures AFTER INSERT OR UPDATE OR DELETE ON subkit."execution_fixtures" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_execution_fixtures();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['execution_fixtures'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."request"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."response"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."body"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."execution_fixtures" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_execution_steps() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_execution_steps AFTER INSERT OR UPDATE OR DELETE ON subkit."execution_steps" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_execution_steps();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['execution_steps'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."step_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."input_preview"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."output_preview"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."result_storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."result_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."result_preview"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."request_meta"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."credential_snapshots"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."placeholders_used"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."redacted_fields"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."execution_steps" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_executions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_executions AFTER INSERT OR UPDATE OR DELETE ON subkit."executions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_executions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['executions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."tool_approval_dispatches"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."source_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."source_ref"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."caller_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."caller_origin"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."authorization_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."sensitive_result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."request_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."authority_call_path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."result_storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."result_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."idempotency_key"::text,'UTF8')),0)::bigint + CASE WHEN subkit.hosted_content_quota_terminal('executions',to_jsonb(r)) THEN 0::bigint ELSE COALESCE(octet_length(convert_to(r."failure"::text,'UTF8')),0)::bigint END + COALESCE(octet_length(convert_to(r."output_contract"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."guard_bucket"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."guard_unit_key"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."executions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_file_links() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_file_links AFTER INSERT OR UPDATE OR DELETE ON subkit."file_links" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_file_links();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['file_links'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."role"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."file_links" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_files() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_files AFTER INSERT OR UPDATE OR DELETE ON subkit."files" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_files();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['files'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."filename"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."content_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."scan_result"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."catalog_input_hash"::text,'UTF8')),0)::bigint + r."size_bytes"::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."files" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_group_members() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_group_members AFTER INSERT OR UPDATE OR DELETE ON subkit."group_members" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_group_members();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['group_members'],to_jsonb(s.count::text)) FROM (SELECT (SELECT tenant_id FROM subkit."groups" WHERE id=r."group_id") AS tenant_id,COALESCE(sum(0::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."group_members" r GROUP BY (SELECT tenant_id FROM subkit."groups" WHERE id=r."group_id")) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_group_role_assignments() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_group_role_assignments AFTER INSERT OR UPDATE OR DELETE ON subkit."group_role_assignments" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_group_role_assignments();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['group_role_assignments'],to_jsonb(s.count::text)) FROM (SELECT (SELECT tenant_id FROM subkit."groups" WHERE id=r."group_id") AS tenant_id,COALESCE(sum(0::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."group_role_assignments" r GROUP BY (SELECT tenant_id FROM subkit."groups" WHERE id=r."group_id")) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_groups() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_groups AFTER INSERT OR UPDATE OR DELETE ON subkit."groups" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_groups();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['groups'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."groups" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_hosted_storage_objects() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_hosted_storage_objects AFTER INSERT OR UPDATE OR DELETE ON subkit."hosted_storage_objects" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_hosted_storage_objects();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['hosted_storage_objects'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(r."declared_bytes"::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."hosted_storage_objects" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_intake_category_defaults() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_intake_category_defaults AFTER INSERT OR UPDATE OR DELETE ON subkit."intake_category_defaults" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_category_defaults();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['intake_category_defaults'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."intake_category_defaults" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_intake_item_evidence() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_intake_item_evidence AFTER INSERT OR UPDATE OR DELETE ON subkit."intake_item_evidence" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_item_evidence();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['intake_item_evidence'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."agent"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."session_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."repo"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."excerpt"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."recorded_by_type"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."intake_item_evidence" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_intake_items() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_intake_items AFTER INSERT OR UPDATE OR DELETE ON subkit."intake_items" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_items();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['intake_items'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."creation_request_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."original_snapshot"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."note"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."collected_by_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."admitted_target_kind"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."intake_items" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_intake_proposal_items() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_intake_proposal_items AFTER INSERT OR UPDATE OR DELETE ON subkit."intake_proposal_items" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_proposal_items();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['intake_proposal_items'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."source_title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."source_url"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."intake_proposal_items" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_intake_proposal_revisions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_intake_proposal_revisions AFTER INSERT OR UPDATE OR DELETE ON subkit."intake_proposal_revisions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_proposal_revisions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['intake_proposal_revisions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."target"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."created_by_type"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."intake_proposal_revisions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_intake_proposals() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_intake_proposals AFTER INSERT OR UPDATE OR DELETE ON subkit."intake_proposals" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_intake_proposals();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['intake_proposals'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."confirmed_target_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."stale_reason"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."intake_proposals" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_knowledge_chunks() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_knowledge_chunks AFTER INSERT OR UPDATE OR DELETE ON subkit."knowledge_chunks" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_knowledge_chunks();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['knowledge_chunks'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."path"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."tsv"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."embedding"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."embedding_model"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."knowledge_chunks" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_knowledge_source_versions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_knowledge_source_versions AFTER INSERT OR UPDATE OR DELETE ON subkit."knowledge_source_versions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_knowledge_source_versions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['knowledge_source_versions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."content"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."content_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."note"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."knowledge_source_versions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_knowledge_sources() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_knowledge_sources AFTER INSERT OR UPDATE OR DELETE ON subkit."knowledge_sources" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_knowledge_sources();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['knowledge_sources'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."source_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."source_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."mime_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."refresh_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."refresh_webhook_secret"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."knowledge_sources" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_mcp_tasks() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_mcp_tasks AFTER INSERT OR UPDATE OR DELETE ON subkit."mcp_tasks" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_mcp_tasks();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['mcp_tasks'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."job_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."request_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."result"::text,'UTF8')),0)::bigint + CASE WHEN subkit.hosted_content_quota_terminal('mcp_tasks',to_jsonb(r)) THEN 0::bigint ELSE COALESCE(octet_length(convert_to(r."failure_reason"::text,'UTF8')),0)::bigint END + COALESCE(octet_length(convert_to(r."phase"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."last_action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."progress_step"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."parked_reason"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."mcp_tasks" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_notification_channels() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_notification_channels AFTER INSERT OR UPDATE OR DELETE ON subkit."notification_channels" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_notification_channels();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['notification_channels'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."channel_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."platform"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."default_severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."circuit_state"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."notification_channels" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_notification_deliveries() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_notification_deliveries AFTER INSERT OR UPDATE OR DELETE ON subkit."notification_deliveries" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_notification_deliveries();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['notification_deliveries'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."event_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."event_payload"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."error"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."notification_deliveries" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_notification_rules() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_notification_rules AFTER INSERT OR UPDATE OR DELETE ON subkit."notification_rules" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_notification_rules();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['notification_rules'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."event_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."workflow_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."severity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."request_source_filter"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."target_workspace_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."target_channel_id"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."notification_rules" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_outbound_connection_starts() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_outbound_connection_starts AFTER INSERT OR UPDATE OR DELETE ON subkit."outbound_connection_starts" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_outbound_connection_starts();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['outbound_connection_starts'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."actor_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."state_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."code_verifier"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."redirect_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."issuer"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."authorization_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."token_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."registration_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."client_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."service_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."service_description"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."outbound_connection_starts" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_outbound_connections() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_outbound_connections AFTER INSERT OR UPDATE OR DELETE ON subkit."outbound_connections" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_outbound_connections();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['outbound_connections'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."base_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."issuer"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."authorization_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."token_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."registration_endpoint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."client_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."verified_identity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."granted_scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."service_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."service_description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."last_error"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."outbound_connections" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_patch_candidates() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_patch_candidates AFTER INSERT OR UPDATE OR DELETE ON subkit."patch_candidates" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_patch_candidates();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['patch_candidates'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."diff"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."closed_reason"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."patch_candidates" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_portal_tokens() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_portal_tokens AFTER INSERT OR UPDATE OR DELETE ON subkit."portal_tokens" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_portal_tokens();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['portal_tokens'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."enduser_ref"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."prefix"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."allowed_workflows"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."portal_tokens" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_request_hooks() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_request_hooks AFTER INSERT OR UPDATE OR DELETE ON subkit."request_hooks" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_request_hooks();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['request_hooks'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."role"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."stdlib_version"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."request_hooks" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_resource_grants() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_resource_grants AFTER INSERT OR UPDATE OR DELETE ON subkit."resource_grants" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_resource_grants();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['resource_grants'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."subject_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."resource_type"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."resource_grants" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_role_permissions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_role_permissions AFTER INSERT OR UPDATE OR DELETE ON subkit."role_permissions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_role_permissions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['role_permissions'],to_jsonb(s.count::text)) FROM (SELECT (SELECT tenant_id FROM subkit."roles" WHERE id=r."role_id") AS tenant_id,COALESCE(sum(0::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."role_permissions" r GROUP BY (SELECT tenant_id FROM subkit."roles" WHERE id=r."role_id")) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_roles() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_roles AFTER INSERT OR UPDATE OR DELETE ON subkit."roles" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_roles();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['roles'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."roles" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_schema_versions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_schema_versions AFTER INSERT OR UPDATE OR DELETE ON subkit."schema_versions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_schema_versions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['schema_versions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."step_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."observed_schema"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."schema_versions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_self_healing_scans() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_self_healing_scans AFTER INSERT OR UPDATE OR DELETE ON subkit."self_healing_scans" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_self_healing_scans();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['self_healing_scans'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."filters"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."idempotency_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."status"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."error"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."self_healing_scans" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_skill_candidate_evidence() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_skill_candidate_evidence AFTER INSERT OR UPDATE OR DELETE ON subkit."skill_candidate_evidence" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_skill_candidate_evidence();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['skill_candidate_evidence'],to_jsonb(s.count::text)) FROM (SELECT (SELECT tenant_id FROM subkit."skill_candidates" WHERE id=r."skill_candidate_id") AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."evidence_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."summary"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."skill_candidate_evidence" r GROUP BY (SELECT tenant_id FROM subkit."skill_candidates" WHERE id=r."skill_candidate_id")) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_skill_candidates() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_skill_candidates AFTER INSERT OR UPDATE OR DELETE ON subkit."skill_candidates" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_skill_candidates();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['skill_candidates'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."endpoint_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."examples"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."evidence"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."tags"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."skill_candidates" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_skill_effectiveness() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_skill_effectiveness AFTER INSERT OR UPDATE OR DELETE ON subkit."skill_effectiveness" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_skill_effectiveness();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['skill_effectiveness'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(0::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."skill_effectiveness" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_skills() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_skills AFTER INSERT OR UPDATE OR DELETE ON subkit."skills" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_skills();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['skills'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."title"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."body"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."examples"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."arguments"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."seed_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."gates_tools"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."activates_when"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."input_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."output_schema"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."side_effects"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."idempotency"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."maturity"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."applies_to"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."skills" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_subscriptions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_subscriptions AFTER INSERT OR UPDATE OR DELETE ON subkit."subscriptions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_subscriptions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['subscriptions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."event_pattern"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."target_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."secret_ciphertext"),0)::bigint + COALESCE(octet_length(r."secret_iv"),0)::bigint + COALESCE(octet_length(r."secret_auth_tag"),0)::bigint + COALESCE(octet_length(r."rotating_secret_ciphertext"),0)::bigint + COALESCE(octet_length(r."rotating_secret_iv"),0)::bigint + COALESCE(octet_length(r."rotating_secret_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(r."filters"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."subscriptions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_system_accounts() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_system_accounts AFTER INSERT OR UPDATE OR DELETE ON subkit."system_accounts" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_system_accounts();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['system_accounts'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."system_accounts" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_tenant_dlp_rules() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."path_match"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."pattern_regex"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."reason"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."path_match"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."pattern_regex"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."reason"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'tenant_dlp_rules',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hosted_meter_tenant_dlp_rules AFTER INSERT OR UPDATE OR DELETE ON subkit."tenant_dlp_rules" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tenant_dlp_rules();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['tenant_dlp_rules'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."path_match"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."pattern_regex"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."reason"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."tenant_dlp_rules" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_tenant_skill_overrides() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_tenant_skill_overrides AFTER INSERT OR UPDATE OR DELETE ON subkit."tenant_skill_overrides" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tenant_skill_overrides();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['tenant_skill_overrides'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."skill_slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."body_override"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."tenant_skill_overrides" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_tenants() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
END $$;
CREATE TRIGGER hosted_meter_tenants AFTER INSERT OR UPDATE OR DELETE ON subkit."tenants" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tenants();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['tenants'],to_jsonb(s.count::text)) FROM (SELECT r.id AS tenant_id,COALESCE(sum(CASE WHEN r.deleted_at IS NOT NULL AND r.status='pending_deletion' AND r.display_name='Deleted workspace' AND r.slug ~ '^[0-9a-f-]{36}$' AND r.llm_primary IS NULL AND r.llm_fallback IS NULL AND r.egress_guard_mode IS NULL AND r.timezone='UTC' THEN 0::bigint ELSE COALESCE(octet_length(convert_to(r."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."llm_primary"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."llm_fallback"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."timezone"::text,'UTF8')),0)::bigint END),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."tenants" r GROUP BY r.id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_tool_approvals() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_tool_approvals AFTER INSERT OR UPDATE OR DELETE ON subkit."tool_approvals" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tool_approvals();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['tool_approvals'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."caller_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."authorization_context"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."tool"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."surface"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."execution_mode"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."args_ciphertext"),0)::bigint + COALESCE(octet_length(r."args_iv"),0)::bigint + COALESCE(octet_length(r."args_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(r."args_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."preview_ciphertext"),0)::bigint + COALESCE(octet_length(r."preview_iv"),0)::bigint + COALESCE(octet_length(r."preview_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(r."portal_token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."granted_via"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."tool_approvals" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_user_identities() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_user_identities AFTER INSERT OR UPDATE OR DELETE ON subkit."user_identities" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_user_identities();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['user_identities'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."provider_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."issuer_url"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."product_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."subject"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."email"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."user_identities" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_user_invites() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_user_invites AFTER INSERT OR UPDATE OR DELETE ON subkit."user_invites" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_user_invites();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['user_invites'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."prefix"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."token_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."scopes"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."allowed_workflows"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."allowed_connectors"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."user_invites" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_user_llm_settings() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_user_llm_settings AFTER INSERT OR UPDATE OR DELETE ON subkit."user_llm_settings" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_user_llm_settings();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['user_llm_settings'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(0::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."user_llm_settings" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_users() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_users AFTER INSERT OR UPDATE OR DELETE ON subkit."users" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_users();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['users'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."email"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."display_name"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."users" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_vendor_recipe_overrides() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_vendor_recipe_overrides AFTER INSERT OR UPDATE OR DELETE ON subkit."vendor_recipe_overrides" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_vendor_recipe_overrides();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['vendor_recipe_overrides'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."client"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."override"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."vendor_recipe_overrides" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_webhooks_inbound() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_webhooks_inbound AFTER INSERT OR UPDATE OR DELETE ON subkit."webhooks_inbound" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_webhooks_inbound();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['webhooks_inbound'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."verifier"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."native_verifier_config"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."secret_ciphertext"),0)::bigint + COALESCE(octet_length(r."secret_iv"),0)::bigint + COALESCE(octet_length(r."secret_auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(r."origin"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."admission_hold"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."webhooks_inbound" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_webhooks_outbound() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_webhooks_outbound AFTER INSERT OR UPDATE OR DELETE ON subkit."webhooks_outbound" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_webhooks_outbound();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['webhooks_outbound'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."signing_keys"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."circuit_state"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."webhooks_outbound" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_workflow_autoheal_policies() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_workflow_autoheal_policies AFTER INSERT OR UPDATE OR DELETE ON subkit."workflow_autoheal_policies" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_autoheal_policies();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['workflow_autoheal_policies'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(0::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."workflow_autoheal_policies" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_workflow_execution_authorities() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_workflow_execution_authorities AFTER INSERT OR UPDATE OR DELETE ON subkit."workflow_execution_authorities" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_execution_authorities();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['workflow_execution_authorities'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."effect_manifest_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."effect_manifest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."target_constraints"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."approved_manifest"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."workflow_execution_authorities" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_workflow_run_state() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_workflow_run_state AFTER INSERT OR UPDATE OR DELETE ON subkit."workflow_run_state" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_run_state();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['workflow_run_state'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."ciphertext"),0)::bigint + COALESCE(octet_length(r."iv"),0)::bigint + COALESCE(octet_length(r."auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(r."value_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."note"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."workflow_run_state" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_workflow_signals() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_workflow_signals AFTER INSERT OR UPDATE OR DELETE ON subkit."workflow_signals" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_signals();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['workflow_signals'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."event_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."payload"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."workflow_signals" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_workflow_versions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_workflow_versions AFTER INSERT OR UPDATE OR DELETE ON subkit."workflow_versions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_versions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['workflow_versions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."dag"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."note"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."authority_growth"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."scope_index"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."workflow_versions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_workflow_waits() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_workflow_waits AFTER INSERT OR UPDATE OR DELETE ON subkit."workflow_waits" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_waits();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['workflow_waits'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."step_id"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."workflow_waits" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_workflows() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_workflows AFTER INSERT OR UPDATE OR DELETE ON subkit."workflows" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflows();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['workflows'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."health_state"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."health_reason"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."workflows" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_workflows_schedules() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_workflows_schedules AFTER INSERT OR UPDATE OR DELETE ON subkit."workflows_schedules" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflows_schedules();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['workflows_schedules'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."timezone"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."input"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."admission_hold"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."input_error"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."workflows_schedules" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_cascade_group_members() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_bytes bigint; v_count bigint;
BEGIN
 SELECT COALESCE(sum(0::bigint),0)::bigint,count(*) INTO v_bytes,v_count FROM subkit."group_members" r WHERE r."group_id"=OLD.id;
 IF v_count>0 THEN PERFORM subkit.hosted_apply_usage(OLD.tenant_id,'group_members',-v_bytes,-v_count); END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER hosted_cascade_group_members BEFORE DELETE ON subkit."groups" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_cascade_group_members();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_cascade_group_role_assignments() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_bytes bigint; v_count bigint;
BEGIN
 SELECT COALESCE(sum(0::bigint),0)::bigint,count(*) INTO v_bytes,v_count FROM subkit."group_role_assignments" r WHERE r."group_id"=OLD.id;
 IF v_count>0 THEN PERFORM subkit.hosted_apply_usage(OLD.tenant_id,'group_role_assignments',-v_bytes,-v_count); END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER hosted_cascade_group_role_assignments BEFORE DELETE ON subkit."groups" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_cascade_group_role_assignments();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_cascade_role_permissions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_bytes bigint; v_count bigint;
BEGIN
 SELECT COALESCE(sum(0::bigint),0)::bigint,count(*) INTO v_bytes,v_count FROM subkit."role_permissions" r WHERE r."role_id"=OLD.id;
 IF v_count>0 THEN PERFORM subkit.hosted_apply_usage(OLD.tenant_id,'role_permissions',-v_bytes,-v_count); END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER hosted_cascade_role_permissions BEFORE DELETE ON subkit."roles" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_cascade_role_permissions();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_cascade_skill_candidate_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_bytes bigint; v_count bigint;
BEGIN
 SELECT COALESCE(sum(COALESCE(octet_length(convert_to(r."evidence_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."summary"::text,'UTF8')),0)::bigint),0)::bigint,count(*) INTO v_bytes,v_count FROM subkit."skill_candidate_evidence" r WHERE r."skill_candidate_id"=OLD.id;
 IF v_count>0 THEN PERFORM subkit.hosted_apply_usage(OLD.tenant_id,'skill_candidate_evidence',-v_bytes,-v_count); END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER hosted_cascade_skill_candidate_evidence BEFORE DELETE ON subkit."skill_candidates" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_cascade_skill_candidate_evidence();
--> statement-breakpoint
UPDATE subkit.hosted_budget_reservations r SET request_key=encode(public.digest(r.request_key,'sha256'),'hex') FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
UPDATE subkit.llm_usage r SET error='provider_error' FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service' AND r.error IS NOT NULL
--> statement-breakpoint
UPDATE subkit.external_call_metering r SET error='provider_error' FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service' AND r.error IS NOT NULL
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_operational_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
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
 ELSIF TG_TABLE_NAME='hosted_budget_reservations' THEN
  valid:=valid AND j->>'request_key' ~ '^[0-9a-f]{64}$' AND j->>'currency'='USD'
   AND j->>'month_bucket' ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND j->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$';
 ELSIF TG_TABLE_NAME='llm_usage' THEN
  valid:=valid AND j->>'flow'=ANY(ARRAY['generate','extract','catalog_describe','repair','tool_repair','converse','discover','summarize','suggest_next','critic_authoring','judge','workflow_step'])
   AND j->>'result'=ANY(ARRAY['success','quota_exhausted','context_too_large','error']) AND j->>'actor_type'=ANY(ARRAY['system','user','system_account'])
   AND j->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$';
 ELSIF TG_TABLE_NAME='hosted_work_admissions' THEN
  valid:=valid AND (j->>'queue_name' IS NULL OR j->>'queue_name'=ANY(ARRAY['execution.run','conversation.run-turn','chat.event']))
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
END $fn$
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."hosted_budget_reservations" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."hosted_budget_reservations" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."hosted_work_admissions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."hosted_work_admissions" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."llm_usage" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."llm_usage" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."usage_events" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."usage_events" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."external_call_metering" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."external_call_metering" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."caller_budget_units" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."caller_budget_units" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."tenant_erasure_states" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."tenant_erasure_states" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."product_identity_tombstones" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."product_identity_tombstones" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."webhook_replay_seen" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."webhook_replay_seen" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."chat_events_seen" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."chat_events_seen" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."sessions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."sessions" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."oidc_login_states" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."oidc_login_states" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."mcp_oauth_access_tokens" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."mcp_oauth_access_tokens" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."mcp_oauth_authorization_codes" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."mcp_oauth_authorization_codes" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."mcp_oauth_grants" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."mcp_oauth_grants" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."mcp_oauth_refresh_tokens" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."mcp_oauth_refresh_tokens" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."mcp_oauth_states" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."mcp_oauth_states" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."mcp_oauth_unknown_grants" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."mcp_oauth_unknown_grants" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."connector_oauth_states" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."connector_oauth_states" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."connector_oauth_start_grants" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."connector_oauth_start_grants" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."connector_credential_setup_grants" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."connector_credential_setup_grants" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."hosted_storage_objects" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard()
--> statement-breakpoint
UPDATE subkit."hosted_storage_objects" r SET tenant_id=r.tenant_id FROM subkit.tenants t WHERE t.id=r.tenant_id AND t.origin='self_service'
--> statement-breakpoint
UPDATE subkit.files f SET size_bytes=f.size_bytes FROM subkit.tenants t WHERE t.id=f.tenant_id AND t.origin='self_service'
