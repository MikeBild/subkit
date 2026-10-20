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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_singleton_control_receipt(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE kind text:=j->>'resource_type'; resource uuid; tenant uuid;
BEGIN
 IF NOT COALESCE(j->>'resource_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false) THEN RETURN false; END IF;
 resource:=(j->>'resource_id')::uuid;tenant:=(j->>'tenant_id')::uuid;
 IF (j->>'id')::uuid<>subkit.hosted_control_receipt_id(tenant,kind,resource) OR j->>'before' IS NOT NULL OR j->>'after' IS NOT NULL OR j->>'ip' IS NOT NULL OR j->>'user_agent' IS NOT NULL OR COALESCE(length(j->>'trace_id'),0)>128 THEN RETURN false; END IF;
 IF kind IN ('execution','mcp_task') THEN RETURN COALESCE(j->>'actor_type'='system' AND j->>'actor_id' IS NULL AND j->>'result'='denied' AND j->>'reason' IN ('hosted_storage_quota_exhausted','hosted_resource_count_exhausted') AND j->'metadata'=jsonb_build_object('code',j->>'reason') AND j->>'action'=CASE kind WHEN 'execution' THEN 'execution.failed' ELSE 'conversation.turn_failed' END,false); END IF;
 IF kind='session' THEN RETURN COALESCE(j->>'actor_type'='user' AND j->>'actor_id' IS NOT NULL AND j->>'result'='success' AND j->>'action'='session.revoked' AND j->>'reason'='installation_revoked' AND (j->'metadata')-ARRAY['installation_id']='{}'::jsonb AND j#>>'{metadata,installation_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false); END IF;
 IF kind='cockpit_installation' THEN RETURN COALESCE(j->>'actor_type'='user' AND j->>'actor_id' IS NOT NULL AND j->>'result'='success' AND j->>'action'='cockpit_installation.revoked' AND j->>'reason' IS NULL AND (j->'metadata')-ARRAY['revoked_session_count']='{}'::jsonb AND j#>>'{metadata,revoked_session_count}' ~ '^(0|[1-9][0-9]{0,8})$',false); END IF;
 IF kind='hosted_storage_object' THEN RETURN COALESCE(j->>'actor_type'='user' AND j->>'actor_id' IS NOT NULL AND j->>'result'='success' AND j->>'action'='hosted_storage_object.reconciled' AND j->>'reason'='operator_reviewed_remote_upload_stop' AND (j->'metadata')-ARRAY['storage_namespace','evidence_sha256','operator_tenant_id']='{}'::jsonb AND j#>>'{metadata,storage_namespace}' ~ '^[0-9a-f]{64}$' AND j#>>'{metadata,evidence_sha256}' ~ '^[0-9a-f]{64}$' AND j#>>'{metadata,operator_tenant_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false); END IF;
 RETURN false;
END $$;
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
 ELSIF NEW.resource_type='session' THEN
  PERFORM 1 FROM subkit.sessions s JOIN subkit.cockpit_installations i ON i.id=s.installation_id WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.resource_id::uuid AND s.installation_id=(NEW.metadata->>'installation_id')::uuid AND s.revoked_at IS NOT NULL AND i.tenant_id=NEW.tenant_id AND i.owner_user_id=NEW.actor_id AND i.revoked_at IS NOT NULL FOR KEY SHARE OF s,i;
  valid:=FOUND;
 ELSIF NEW.resource_type='cockpit_installation' THEN
  PERFORM 1 FROM subkit.cockpit_installations i WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.resource_id::uuid AND i.owner_user_id=NEW.actor_id AND i.revoked_at IS NOT NULL FOR KEY SHARE;
  valid:=FOUND;
 ELSE
  PERFORM 1 FROM subkit.hosted_storage_objects o WHERE o.tenant_id=NEW.tenant_id AND o.id=NEW.resource_id::uuid AND o.state='pending' AND o.storage_namespace=NEW.metadata->>'storage_namespace' FOR KEY SHARE;
  valid:=FOUND AND EXISTS(SELECT 1 FROM subkit.users u JOIN subkit.tenants t ON t.id=u.tenant_id WHERE u.id=NEW.actor_id AND t.id=(NEW.metadata->>'operator_tenant_id')::uuid AND t.is_operator AND t.status='active' AND t.deleted_at IS NULL AND u.status='active' AND u.deleted_at IS NULL);
 END IF;
 IF NOT valid THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_quota_control_receipt_invalid'; END IF;
 RETURN NEW;
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
