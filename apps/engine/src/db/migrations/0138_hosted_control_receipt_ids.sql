CREATE OR REPLACE FUNCTION subkit.hosted_singleton_control_receipt(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
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
END $$;
