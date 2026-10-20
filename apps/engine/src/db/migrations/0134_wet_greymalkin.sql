CREATE TABLE "cockpit_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cockpit_push_keys" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cockpit_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"endpoint_sha256" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oidc_login_states" ADD COLUMN "installation_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "installation_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD COLUMN "app_icon_192" "bytea";--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD COLUMN "app_icon_512" "bytea";--> statement-breakpoint
ALTER TABLE "cockpit_installations" ADD CONSTRAINT "cockpit_installations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cockpit_installations" ADD CONSTRAINT "cockpit_installations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "subkit"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cockpit_push_keys" ADD CONSTRAINT "cockpit_push_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cockpit_push_subscriptions" ADD CONSTRAINT "cockpit_push_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cockpit_push_subscriptions" ADD CONSTRAINT "cockpit_push_subscriptions_installation_id_cockpit_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "subkit"."cockpit_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cockpit_push_subscriptions" ADD CONSTRAINT "cockpit_push_subscriptions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "subkit"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cockpit_installations_active_tenant_owner_key" ON "cockpit_installations" USING btree ("tenant_id","owner_user_id") WHERE "cockpit_installations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "cockpit_installations_tenant_owner_idx" ON "cockpit_installations" USING btree ("tenant_id","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cockpit_push_subscriptions_installation_session_key" ON "cockpit_push_subscriptions" USING btree ("installation_id","session_id");--> statement-breakpoint
CREATE INDEX "cockpit_push_subscriptions_tenant_installation_idx" ON "cockpit_push_subscriptions" USING btree ("tenant_id","installation_id");--> statement-breakpoint
CREATE INDEX "cockpit_push_subscriptions_session_idx" ON "cockpit_push_subscriptions" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "oidc_login_states" ADD CONSTRAINT "oidc_login_states_installation_id_cockpit_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "subkit"."cockpit_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_installation_id_cockpit_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "subkit"."cockpit_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_installation_idx" ON "sessions" USING btree ("installation_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_cockpit_installations() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(0::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(0::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'cockpit_installations',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hosted_meter_cockpit_installations AFTER INSERT OR UPDATE OR DELETE ON subkit."cockpit_installations" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_cockpit_installations();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['cockpit_installations'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(0::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."cockpit_installations" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_cockpit_push_keys() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_cockpit_push_keys AFTER INSERT OR UPDATE OR DELETE ON subkit."cockpit_push_keys" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_cockpit_push_keys();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['cockpit_push_keys'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(r."ciphertext"),0)::bigint + COALESCE(octet_length(r."iv"),0)::bigint + COALESCE(octet_length(r."auth_tag"),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."cockpit_push_keys" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_cockpit_push_subscriptions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
CREATE TRIGGER hosted_meter_cockpit_push_subscriptions AFTER INSERT OR UPDATE OR DELETE ON subkit."cockpit_push_subscriptions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_cockpit_push_subscriptions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['cockpit_push_subscriptions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."endpoint_sha256"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."ciphertext"),0)::bigint + COALESCE(octet_length(r."iv"),0)::bigint + COALESCE(octet_length(r."auth_tag"),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."cockpit_push_subscriptions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_tenant_branding() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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

