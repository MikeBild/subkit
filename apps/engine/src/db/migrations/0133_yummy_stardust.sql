CREATE TYPE "public"."tenant_branding_palette" AS ENUM('standard', 'indigo', 'teal');--> statement-breakpoint
CREATE TABLE "tenant_branding" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"display_name" text,
	"subtitle" text,
	"palette" "tenant_branding_palette",
	"logo_light" "bytea",
	"logo_dark" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_branding_revision_check" CHECK ("tenant_branding"."revision" >= 0 AND "tenant_branding"."revision" <= 9007199254740991),
	CONSTRAINT "tenant_branding_display_name_check" CHECK ("tenant_branding"."display_name" IS NULL OR char_length("tenant_branding"."display_name") <= 80),
	CONSTRAINT "tenant_branding_subtitle_check" CHECK ("tenant_branding"."subtitle" IS NULL OR char_length("tenant_branding"."subtitle") <= 160)
);
--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_tenant_branding() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."subtitle"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."logo_light"),0)::bigint + COALESCE(octet_length(OLD."logo_dark"),0)::bigint);v_count:=v_count-1; END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."subtitle"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."logo_light"),0)::bigint + COALESCE(octet_length(NEW."logo_dark"),0)::bigint);v_count:=v_count+1; END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'tenant_branding',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hosted_meter_tenant_branding AFTER INSERT OR UPDATE OR DELETE ON subkit."tenant_branding" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tenant_branding();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['tenant_branding'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."display_name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."subtitle"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."logo_light"),0)::bigint + COALESCE(octet_length(r."logo_dark"),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."tenant_branding" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
