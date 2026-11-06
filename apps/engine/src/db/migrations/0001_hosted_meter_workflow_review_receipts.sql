CREATE OR REPLACE FUNCTION subkit.hosted_meter_workflow_review_receipts() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE OR REPLACE TRIGGER hosted_meter_workflow_review_receipts AFTER INSERT OR UPDATE OR DELETE ON subkit."workflow_review_receipts" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_workflow_review_receipts();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['workflow_review_receipts'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."snapshot"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."snapshot_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."status"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."workflow_review_receipts" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id AND NOT (u.resource_counts ? 'workflow_review_receipts');
