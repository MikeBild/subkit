DROP TABLE IF EXISTS subkit."hosted_budget_reservations" CASCADE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_operational_guard() RETURNS trigger
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
END $_$;
