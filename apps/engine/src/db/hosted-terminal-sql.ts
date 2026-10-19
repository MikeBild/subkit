export function renderHostedTerminalSql(): string[] {
  return [
    `CREATE OR REPLACE FUNCTION subkit.hosted_control_receipt_id(p_tenant uuid,p_type text,p_resource uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT overlay(overlay(substr(encode(public.digest('hosted-resource-control:'||p_tenant::text||':'||p_type||':'||p_resource::text,'sha256'),'hex'),1,32) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
$$`,
    `CREATE OR REPLACE FUNCTION subkit.hosted_content_quota_terminal(p_table text,j jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(CASE WHEN p_table='executions' THEN
  j->>'status'='failed' AND j->>'finished_at' IS NOT NULL AND j#>>'{failure,error_code}' IN ('hosted_storage_quota_exhausted','hosted_resource_count_exhausted')
  AND j->'failure'=jsonb_build_object('step_id',NULL,'error_code',j#>>'{failure,error_code}','error_message','Workspace resource allowance exhausted.')
 WHEN p_table='mcp_tasks' THEN
  j->>'failure_reason' IN ('hosted_storage_quota_exhausted','hosted_resource_count_exhausted') AND j->>'result' IS NULL AND j->>'cancelled_at' IS NULL
 ELSE false END,false)
$$`,
    `CREATE OR REPLACE FUNCTION subkit.hosted_singleton_control_receipt(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
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
END $$`,
    `CREATE OR REPLACE FUNCTION subkit.hosted_singleton_control_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER hosted_singleton_control_guard BEFORE INSERT OR UPDATE ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.hosted_singleton_control_guard()`,
    `CREATE OR REPLACE FUNCTION subkit.hosted_terminal_receipt_required() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER hosted_terminal_receipt_required AFTER INSERT OR UPDATE ON subkit.mcp_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION subkit.hosted_terminal_receipt_required()`,
  ];
}
