CREATE TABLE "file_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"filename" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint NOT NULL,
	"storage_uri" text NOT NULL,
	"sha256" text,
	"restored_from" integer,
	"uploaded_at" timestamp with time zone NOT NULL,
	"uploaded_by_kind" "audit_actor_kind",
	"uploaded_by" uuid,
	"replaced_at" timestamp with time zone NOT NULL,
	"replaced_by_kind" "audit_actor_kind",
	"replaced_by" uuid,
	CONSTRAINT "file_versions_size_bytes_nonnegative" CHECK ("file_versions"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "restored_from" integer;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "subkit"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_versions_tenant_file_version_uq" ON "file_versions" USING btree ("tenant_id","file_id","version");--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_file_versions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_file_versions AFTER INSERT OR UPDATE OR DELETE ON subkit."file_versions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_file_versions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['file_versions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."filename"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."content_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."storage_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."sha256"::text,'UTF8')),0)::bigint + r."size_bytes"::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."file_versions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
