CREATE TABLE "package_install_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"install_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_key" text NOT NULL,
	"local_id" uuid,
	"imported_hash" text NOT NULL,
	"local_hash" text,
	"state" text NOT NULL,
	"intake_proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"package_version" text NOT NULL,
	"format" text NOT NULL,
	"content_digest" text NOT NULL,
	"archive_file_id" uuid,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_by_type" text NOT NULL,
	"installed_by_id" uuid,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "package_install_items" ADD CONSTRAINT "package_install_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_install_items" ADD CONSTRAINT "package_install_items_install_id_package_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "subkit"."package_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_installs" ADD CONSTRAINT "package_installs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_installs" ADD CONSTRAINT "package_installs_archive_file_id_files_id_fk" FOREIGN KEY ("archive_file_id") REFERENCES "subkit"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "package_install_items_tenant_item_key" ON "package_install_items" USING btree ("tenant_id","kind","item_key");--> statement-breakpoint
CREATE INDEX "package_install_items_install_idx" ON "package_install_items" USING btree ("tenant_id","install_id");--> statement-breakpoint
CREATE INDEX "package_installs_tenant_package_idx" ON "package_installs" USING btree ("tenant_id","package_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_package_install_items() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_package_install_items AFTER INSERT OR UPDATE OR DELETE ON subkit."package_install_items" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_package_install_items();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['package_install_items'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."item_key"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."imported_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."local_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."state"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."package_install_items" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_package_installs() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_package_installs AFTER INSERT OR UPDATE OR DELETE ON subkit."package_installs" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_package_installs();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['package_installs'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."package_id"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."package_version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."format"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."content_digest"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."installed_by_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."summary"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."package_installs" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
