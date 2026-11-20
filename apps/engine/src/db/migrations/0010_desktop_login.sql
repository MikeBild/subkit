CREATE TABLE IF NOT EXISTS "desktop_login_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"auth_identity_id" uuid,
	"code_sha256" text NOT NULL,
	"code_challenge" text NOT NULL,
	"state_sha256" text NOT NULL,
	"device_id" uuid NOT NULL,
	"device_label" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "cockpit_installations_active_tenant_owner_key";--> statement-breakpoint
ALTER TABLE "cockpit_installations" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "cockpit_installations" ADD COLUMN IF NOT EXISTS "device_id" uuid;--> statement-breakpoint
ALTER TABLE "cockpit_installations" ADD COLUMN IF NOT EXISTS "device_label" text;--> statement-breakpoint
ALTER TABLE "desktop_login_codes" DROP CONSTRAINT IF EXISTS "desktop_login_codes_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "desktop_login_codes" ADD CONSTRAINT "desktop_login_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_login_codes" DROP CONSTRAINT IF EXISTS "desktop_login_codes_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "desktop_login_codes" ADD CONSTRAINT "desktop_login_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "subkit"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "desktop_login_codes_sha256_key" ON "desktop_login_codes" USING btree ("code_sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "desktop_login_codes_tenant_user_idx" ON "desktop_login_codes" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "desktop_login_codes_expires_idx" ON "desktop_login_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cockpit_installations_active_desktop_device_key" ON "cockpit_installations" USING btree ("tenant_id","owner_user_id","device_id") WHERE "cockpit_installations"."revoked_at" IS NULL AND "cockpit_installations"."kind" = 'desktop';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cockpit_installations_active_tenant_owner_key" ON "cockpit_installations" USING btree ("tenant_id","owner_user_id") WHERE "cockpit_installations"."revoked_at" IS NULL AND "cockpit_installations"."kind" = 'browser';--> statement-breakpoint
ALTER TABLE "cockpit_installations" DROP CONSTRAINT IF EXISTS "cockpit_installations_kind_check";--> statement-breakpoint
ALTER TABLE "cockpit_installations" ADD CONSTRAINT "cockpit_installations_kind_check" CHECK ("cockpit_installations"."kind" in ('browser', 'desktop'));--> statement-breakpoint
ALTER TABLE "cockpit_installations" DROP CONSTRAINT IF EXISTS "cockpit_installations_device_check";--> statement-breakpoint
ALTER TABLE "cockpit_installations" ADD CONSTRAINT "cockpit_installations_device_check" CHECK (("cockpit_installations"."kind" = 'desktop' and "cockpit_installations"."device_id" is not null and "cockpit_installations"."device_label" is not null) or ("cockpit_installations"."kind" = 'browser' and "cockpit_installations"."device_id" is null and "cockpit_installations"."device_label" is null));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_cockpit_installations() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE OR REPLACE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."desktop_login_codes" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
