import { renderRuntimeSecretOwnershipSql } from "./runtime-secret-owner-sql.ts";
import { renderVaultStockSql, VAULT_STOCK_TABLES } from "./vault-stock-sql.ts";

export function renderVaultMaintenanceSql(): string {
  const ownerSource = renderRuntimeSecretOwnershipSql();
  const ownerStart = ownerSource.indexOf("CREATE FUNCTION subkit.runtime_secret_owner_guard()");
  const ownerEnd = ownerSource.indexOf(";\nCREATE TRIGGER runtime_secret_owner_guard", ownerStart);
  if (ownerStart < 0 || ownerEnd < 0) throw new Error("runtime_secret_guard_source_missing");
  const ownerGuard = ownerSource
    .slice(ownerStart, ownerEnd + 1)
    .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
    .replace(
      "THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_inactive';",
      "AND NOT subkit.vault_maintenance_update_allowed(to_jsonb(OLD),to_jsonb(NEW)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_inactive';",
    );
  const stockLocks = `LOCK TABLE ${VAULT_STOCK_TABLES.map((table) => `subkit.${table}`).join(",")} IN SHARE MODE;`;
  const parts = [
    `ALTER TABLE subkit.runtime_config_state ADD COLUMN master_key_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE subkit.runtime_config_state ADD COLUMN master_key_digest text;
ALTER TABLE subkit.runtime_config_state ADD COLUMN vault_maintenance_binding jsonb;
ALTER TABLE subkit.runtime_config_state ADD COLUMN vault_maintenance_context jsonb;
ALTER TABLE subkit.runtime_config_state ADD CONSTRAINT runtime_master_key_epoch_valid CHECK(master_key_epoch BETWEEN 0 AND 9007199254740991);
ALTER TABLE subkit.runtime_config_state ADD CONSTRAINT runtime_master_key_digest_valid CHECK(master_key_digest IS NULL OR master_key_digest ~ '^[0-9a-f]{64}$')`,
    `CREATE TYPE subkit.vault_cipher_snapshot AS (name text,version integer,tenant_id uuid,ciphertext bytea,iv bytea,auth_tag bytea,metadata_sha256 text);
CREATE TYPE subkit.vault_snapshot_page AS (operation_id uuid,page_number integer,source_epoch bigint,page_sha256 text,has_more boolean,rows subkit.vault_cipher_snapshot[]);
CREATE TYPE subkit.vault_cipher_replacement AS (name text,version integer,expected_ciphertext bytea,expected_iv bytea,expected_auth_tag bytea,replacement_ciphertext bytea,replacement_iv bytea,replacement_auth_tag bytea,unchanged boolean)`,
    `CREATE FUNCTION subkit.vault_gate_held(p_exclusive boolean) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,subkit,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_catalog.pg_backend_pid() AND l.granted AND l.objsubid=1 AND l.classid=((pg_catalog.hashtextextended('subkit.runtime.vault-maintenance',0)>>32)&4294967295)::oid AND l.objid=(pg_catalog.hashtextextended('subkit.runtime.vault-maintenance',0)&4294967295)::oid AND (l.mode='ExclusiveLock' OR (NOT p_exclusive AND l.mode='ShareLock')))
$$`,
    renderVaultStockSql(),
    `CREATE FUNCTION subkit.vault_stock_frozen() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,subkit,pg_temp AS $$
 SELECT count(DISTINCT c.relname)=${VAULT_STOCK_TABLES.length} FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid=l.relation JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_catalog.pg_backend_pid() AND l.granted AND l.locktype='relation' AND l.mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock') AND n.nspname='subkit' AND c.relname=ANY(ARRAY[${VAULT_STOCK_TABLES.map((table) => `'${table}'`).join(",")}])
$$`,
    `CREATE FUNCTION subkit.vault_role_owner_equivalent(p_role oid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,subkit,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role(p_role,r.oid,'MEMBER') AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_signal_backend','pg_checkpoint','pg_maintain','pg_database_owner')))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database() AND pg_catalog.pg_has_role(p_role,d.datdba,'MEMBER'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='subkit' AND pg_catalog.pg_has_role(p_role,n.nspowner,'MEMBER'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='subkit' AND pg_catalog.pg_has_role(p_role,c.relowner,'MEMBER'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='subkit' AND pg_catalog.pg_has_role(p_role,p.proowner,'MEMBER'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='subkit' AND pg_catalog.pg_has_role(p_role,t.typowner,'MEMBER'))
 OR pg_catalog.has_schema_privilege(p_role,'subkit','CREATE')
$$`,
    `CREATE FUNCTION subkit.vault_maintenance_authorize() RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,subkit,pg_temp AS $$
DECLARE b jsonb; role_entry jsonb; runtime_oid oid; maintenance_oid oid; definer_oid oid; snapshot_oid oid; apply_oid oid; status_oid oid; role_count integer;
BEGIN
 SELECT vault_maintenance_binding INTO b FROM subkit.runtime_config_state WHERE key='runtime';
 IF b IS NULL OR jsonb_typeof(b)<>'object' OR b-ARRAY['binding_id','maintenance_login','definer','runtime_logins','inventory_evidence_sha256']<>'{}'::jsonb OR COALESCE(b->>'binding_id','') !~ '^[0-9a-f-]{36}$' OR COALESCE(b->>'inventory_evidence_sha256','') !~ '^[0-9a-f]{64}$' OR jsonb_typeof(b->'runtime_logins') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 IF jsonb_array_length(b->'runtime_logins') NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 SELECT p.oid,p.proowner INTO snapshot_oid,definer_oid FROM pg_catalog.pg_proc p WHERE p.oid='subkit.vault_maintenance_snapshot(uuid,bigint,text,text,text,integer,integer)'::regprocedure;
 SELECT p.oid INTO apply_oid FROM pg_catalog.pg_proc p WHERE p.oid='subkit.vault_maintenance_apply(uuid,text,subkit.vault_cipher_replacement[],boolean)'::regprocedure AND p.proowner=definer_oid;
 SELECT p.oid INTO status_oid FROM pg_catalog.pg_proc p WHERE p.oid='subkit.vault_maintenance_status()'::regprocedure AND p.proowner=definer_oid;
 SELECT r.oid INTO maintenance_oid FROM pg_catalog.pg_roles r WHERE r.rolname=session_user AND r.rolcanlogin;
 IF apply_oid IS NULL OR status_oid IS NULL OR maintenance_oid IS NULL OR current_user::text IS DISTINCT FROM (SELECT rolname::text FROM pg_catalog.pg_roles WHERE oid=definer_oid) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 FOR role_entry IN SELECT value FROM jsonb_array_elements(jsonb_build_array(b->'maintenance_login',b->'definer')||(b->'runtime_logins')) LOOP
  IF jsonb_typeof(role_entry)<>'object' OR role_entry-ARRAY['oid','name']<>'{}'::jsonb OR COALESCE(role_entry->>'oid','') !~ '^[1-9][0-9]{0,9}$' OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid::text=role_entry->>'oid' AND rolname=role_entry->>'name') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 END LOOP;
 IF b#>>'{maintenance_login,oid}'<>maintenance_oid::text OR b#>>'{definer,oid}'<>definer_oid::text OR maintenance_oid=definer_oid OR subkit.vault_role_owner_equivalent(maintenance_oid) OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=snapshot_oid),pg_catalog.acldefault('f',definer_oid))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=apply_oid),pg_catalog.acldefault('f',definer_oid))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=status_oid),pg_catalog.acldefault('f',definer_oid))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='subkit' AND c.relkind IN ('r','p','v','m','f') AND (pg_catalog.has_table_privilege(maintenance_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(maintenance_oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 SELECT count(DISTINCT value->>'oid') INTO role_count FROM jsonb_array_elements(b->'runtime_logins');
 IF role_count<>jsonb_array_length(b->'runtime_logins') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 FOR role_entry IN SELECT value FROM jsonb_array_elements(b->'runtime_logins') LOOP
  runtime_oid:=(role_entry->>'oid')::oid;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=runtime_oid AND rolcanlogin) OR runtime_oid IN (maintenance_oid,definer_oid) OR subkit.vault_role_owner_equivalent(runtime_oid) OR pg_catalog.pg_has_role(runtime_oid,maintenance_oid,'MEMBER') OR pg_catalog.pg_has_role(runtime_oid,definer_oid,'MEMBER') OR pg_catalog.pg_has_role(maintenance_oid,runtime_oid,'MEMBER') OR pg_catalog.has_function_privilege(runtime_oid,snapshot_oid,'EXECUTE') OR pg_catalog.has_function_privilege(runtime_oid,apply_oid,'EXECUTE') OR pg_catalog.has_function_privilege(runtime_oid,status_oid,'EXECUTE') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_capability_unavailable'; END IF;
 END LOOP;
 RETURN b;
END $$;
REVOKE ALL ON FUNCTION subkit.vault_maintenance_authorize() FROM PUBLIC`,
    `CREATE FUNCTION subkit.vault_maintenance_status() RETURNS TABLE(key_epoch bigint,key_digest text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,subkit,pg_temp AS $$
BEGIN
 PERFORM subkit.vault_maintenance_authorize();
 RETURN QUERY SELECT s.master_key_epoch,s.master_key_digest FROM subkit.runtime_config_state s WHERE s.key='runtime';
END $$;
REVOKE ALL ON FUNCTION subkit.vault_maintenance_status() FROM PUBLIC`,
    `CREATE FUNCTION subkit.vault_maintenance_context_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,subkit,pg_temp AS $$
DECLARE state_owner oid; auth_oid oid; trusted boolean; c jsonb;
BEGIN
 SELECT c.relowner INTO state_owner FROM pg_catalog.pg_class c WHERE c.oid='subkit.runtime_config_state'::regclass;
 SELECT oid INTO auth_oid FROM pg_catalog.pg_roles WHERE rolname=session_user;
 trusted:=pg_catalog.pg_has_role(auth_oid,state_owner,'MEMBER') OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=auth_oid AND rolsuper);
 IF TG_OP='DELETE' THEN
  IF NOT trusted THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_key_marker_forbidden'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.vault_maintenance_context IS NOT NULL OR (NEW.vault_maintenance_binding IS NOT NULL AND NOT trusted) OR NEW.master_key_epoch<>0 OR (NEW.master_key_digest IS NOT NULL AND (NOT trusted OR NOT subkit.vault_gate_held(false))) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_key_marker_forbidden'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.key IS DISTINCT FROM OLD.key THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_key_marker_forbidden'; END IF;
 IF NEW.vault_maintenance_binding IS DISTINCT FROM OLD.vault_maintenance_binding AND NOT trusted THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_maintenance_binding_forbidden'; END IF;
 IF NEW.master_key_epoch IS DISTINCT FROM OLD.master_key_epoch OR NEW.master_key_digest IS DISTINCT FROM OLD.master_key_digest THEN
  c:=OLD.vault_maintenance_context;
  IF OLD.master_key_digest IS NULL AND OLD.master_key_epoch=0 AND NEW.master_key_epoch=0 AND NEW.master_key_digest IS NOT NULL AND NEW.vault_maintenance_context IS NULL AND trusted AND subkit.vault_gate_held(false) THEN
   NULL;
  ELSIF c IS NOT NULL AND c->>'applying'='true' AND c->>'transaction_id'=pg_catalog.txid_current()::text AND c->>'target_digest'=NEW.master_key_digest AND NEW.vault_maintenance_context IS NULL AND NEW.master_key_epoch=OLD.master_key_epoch+(CASE WHEN OLD.master_key_digest IS DISTINCT FROM NEW.master_key_digest THEN 1 ELSE 0 END) AND subkit.vault_gate_held(true) THEN
   PERFORM subkit.vault_maintenance_authorize();
  ELSIF trusted AND OLD.vault_maintenance_context IS NULL AND NEW.vault_maintenance_context IS NULL AND subkit.vault_gate_held(true) AND NEW.master_key_digest IS NOT NULL AND NEW.master_key_epoch=OLD.master_key_epoch+1 AND OLD.master_key_digest IS DISTINCT FROM NEW.master_key_digest AND subkit.vault_stock_frozen() AND NOT EXISTS(SELECT 1 FROM subkit.runtime_config_replicas) AND NOT EXISTS(SELECT 1 FROM subkit.hosted_work_admissions WHERE state<>'released') THEN
   IF subkit.vault_non_registry_stock_present() THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='vault_non_registry_stock_unsupported'; END IF;
  ELSE RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='vault_key_marker_forbidden'; END IF;
 END IF;
 IF NEW.vault_maintenance_context IS DISTINCT FROM OLD.vault_maintenance_context THEN PERFORM subkit.vault_maintenance_authorize(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER vault_maintenance_context_guard BEFORE INSERT OR UPDATE OR DELETE ON subkit.runtime_config_state FOR EACH ROW EXECUTE FUNCTION subkit.vault_maintenance_context_guard();
CREATE FUNCTION subkit.vault_maintenance_commit_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,subkit,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM subkit.runtime_config_state WHERE key=NEW.key AND vault_maintenance_context IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='vault_maintenance_incomplete'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER vault_maintenance_commit_guard AFTER INSERT OR UPDATE ON subkit.runtime_config_state DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION subkit.vault_maintenance_commit_guard()`,
    `CREATE FUNCTION subkit.vault_maintenance_update_allowed(p_old jsonb,p_new jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,subkit,pg_temp AS $$
DECLARE b jsonb; c jsonb;
BEGIN
 SELECT vault_maintenance_binding,vault_maintenance_context INTO b,c FROM subkit.runtime_config_state WHERE key='runtime';
 IF c IS NULL OR b#>>'{maintenance_login,name}' IS DISTINCT FROM session_user::text OR b#>>'{definer,name}' IS DISTINCT FROM current_user::text THEN RETURN false; END IF;
 PERFORM subkit.vault_maintenance_authorize();
 RETURN subkit.vault_gate_held(true) AND c->>'transaction_id'=pg_catalog.txid_current()::text AND c->>'binding_sha256'=encode(public.digest(b::text,'sha256'),'hex') AND c->>'applying'='true' AND p_old-ARRAY['ciphertext','iv','auth_tag']=p_new-ARRAY['ciphertext','iv','auth_tag'] AND octet_length(decode(substr(p_old->>'ciphertext',3),'hex'))=octet_length(decode(substr(p_new->>'ciphertext',3),'hex')) AND octet_length(decode(substr(p_new->>'iv',3),'hex'))=12 AND octet_length(decode(substr(p_new->>'auth_tag',3),'hex'))=16;
END $$`,
    `CREATE FUNCTION subkit.vault_maintenance_snapshot(p_operation uuid,p_expected_epoch bigint,p_target_key_sha256 text,p_evidence_sha256 text,p_after_name text,p_after_version integer,p_limit integer DEFAULT 128) RETURNS subkit.vault_snapshot_page LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,subkit,pg_temp AS $$
DECLARE b jsonb; s subkit.runtime_config_state%ROWTYPE; c jsonb; row subkit.runtime_secret_versions%ROWTYPE; payload subkit.vault_cipher_snapshot[]:='{}'; bytes bigint:=0; page_hash text; more boolean:=false; tail_name text; tail_version integer; page_number integer; metadata_hash text; result subkit.vault_snapshot_page;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('subkit.runtime.vault-maintenance',0));
 b:=subkit.vault_maintenance_authorize();
 ${stockLocks}
 LOCK TABLE subkit.runtime_secret_versions IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO s FROM subkit.runtime_config_state WHERE key='runtime' FOR UPDATE;
 IF subkit.vault_non_registry_stock_present() THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='vault_non_registry_stock_unsupported'; END IF;
 IF p_operation IS NULL OR p_expected_epoch IS NULL OR p_expected_epoch<>s.master_key_epoch OR COALESCE(p_target_key_sha256,'') !~ '^[0-9a-f]{64}$' OR COALESCE(p_evidence_sha256,'') !~ '^[0-9a-f]{64}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 128 OR (p_after_name IS NULL)<>(p_after_version IS NULL) OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_request_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM subkit.runtime_config_replicas) OR EXISTS(SELECT 1 FROM subkit.hosted_work_admissions WHERE state<>'released') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='vault_maintenance_producers_unresolved'; END IF;
 c:=s.vault_maintenance_context;
 IF c IS NULL THEN
  IF p_after_name IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_cursor_invalid'; END IF;
  c:=jsonb_build_object('operation_id',p_operation,'transaction_id',pg_catalog.txid_current()::text,'binding_sha256',encode(public.digest(b::text,'sha256'),'hex'),'source_epoch',s.master_key_epoch,'source_digest',s.master_key_digest,'target_digest',p_target_key_sha256,'evidence_sha256',p_evidence_sha256,'page_number',1,'after_name',NULL,'after_version',NULL,'pending',false,'applying',false);
 ELSE
  IF c->>'operation_id'<>p_operation::text OR c->>'transaction_id'<>pg_catalog.txid_current()::text OR c->>'binding_sha256'<>encode(public.digest(b::text,'sha256'),'hex') OR c->>'target_digest'<>p_target_key_sha256 OR c->>'evidence_sha256'<>p_evidence_sha256 OR c->>'pending'<>'false' OR c->>'after_name' IS DISTINCT FROM p_after_name OR (c->>'after_version')::integer IS DISTINCT FROM p_after_version THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_cursor_invalid'; END IF;
 END IF;
 page_number:=(c->>'page_number')::integer;
 FOR row IN SELECT * FROM subkit.runtime_secret_versions WHERE p_after_name IS NULL OR (name,version)>(p_after_name,p_after_version) ORDER BY name,version LIMIT p_limit+1 LOOP
  IF cardinality(payload)>=p_limit OR bytes+octet_length(row.ciphertext)+octet_length(row.iv)+octet_length(row.auth_tag)>67108864 THEN more:=true; EXIT; END IF;
  bytes:=bytes+octet_length(row.ciphertext)+octet_length(row.iv)+octet_length(row.auth_tag);
  metadata_hash:=encode(public.digest((to_jsonb(row)-ARRAY['ciphertext','iv','auth_tag'])::text,'sha256'),'hex');
  payload:=array_append(payload,ROW(row.name,row.version,row.tenant_id,row.ciphertext,row.iv,row.auth_tag,metadata_hash)::subkit.vault_cipher_snapshot);
  tail_name:=row.name;tail_version:=row.version;
 END LOOP;
 IF cardinality(payload)=0 AND more THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='vault_maintenance_page_too_large'; END IF;
 page_hash:=encode(public.digest(to_jsonb(payload)::text,'sha256'),'hex');
 c:=c||jsonb_build_object('pending',true,'page_sha256',page_hash,'row_count',cardinality(payload),'tail_name',tail_name,'tail_version',tail_version,'has_more',more);
 UPDATE subkit.runtime_config_state SET vault_maintenance_context=c WHERE key='runtime';
 result:=ROW(p_operation,page_number,s.master_key_epoch,page_hash,more,payload)::subkit.vault_snapshot_page;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION subkit.vault_maintenance_snapshot(uuid,bigint,text,text,text,integer,integer) FROM PUBLIC`,
    `CREATE FUNCTION subkit.vault_maintenance_apply(p_operation uuid,p_page_sha256 text,p_rows subkit.vault_cipher_replacement[],p_finish boolean) RETURNS TABLE(applied_count integer,unchanged_count integer,result_epoch bigint,audit_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,subkit,pg_temp AS $$
DECLARE b jsonb; s subkit.runtime_config_state%ROWTYPE; c jsonb; entry subkit.vault_cipher_replacement; row subkit.runtime_secret_versions%ROWTYPE; payload subkit.vault_cipher_snapshot[]:='{}'; metadata_hash text; total bigint:=0; changed integer:=0; unchanged_counted integer:=0; result_key_epoch bigint; receipt uuid; receipt_hex text; last_name text; last_version integer;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('subkit.runtime.vault-maintenance',0));
 b:=subkit.vault_maintenance_authorize();
 ${stockLocks}
 LOCK TABLE subkit.runtime_secret_versions IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO s FROM subkit.runtime_config_state WHERE key='runtime' FOR UPDATE;
 IF subkit.vault_non_registry_stock_present() THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='vault_non_registry_stock_unsupported'; END IF;
 IF EXISTS(SELECT 1 FROM subkit.runtime_config_replicas) OR EXISTS(SELECT 1 FROM subkit.hosted_work_admissions WHERE state<>'released') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='vault_maintenance_producers_unresolved'; END IF;
 c:=s.vault_maintenance_context;
 IF c IS NULL OR p_rows IS NULL OR p_finish IS NULL OR cardinality(p_rows)>128 OR cardinality(p_rows)<>(c->>'row_count')::integer OR c->>'pending'<>'true' OR c->>'operation_id' IS DISTINCT FROM p_operation::text OR c->>'transaction_id'<>pg_catalog.txid_current()::text OR c->>'binding_sha256'<>encode(public.digest(b::text,'sha256'),'hex') OR c->>'page_sha256' IS DISTINCT FROM p_page_sha256 OR p_finish=(c->>'has_more')::boolean OR (c->>'source_epoch')::bigint<>s.master_key_epoch THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_page_invalid'; END IF;
 IF (SELECT count(*) FROM unnest(p_rows) e WHERE NOT e.unchanged)<>(SELECT count(DISTINCT e.replacement_iv) FROM unnest(p_rows) e WHERE NOT e.unchanged) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_envelope_invalid'; END IF;
 FOREACH entry IN ARRAY p_rows LOOP
  IF entry.name IS NULL OR length(entry.name)>255 OR entry.version IS NULL OR entry.version<1 OR entry.unchanged IS NULL OR (last_name IS NOT NULL AND (entry.name,entry.version)<=(last_name,last_version)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_page_invalid'; END IF;
  last_name:=entry.name;last_version:=entry.version;
  SELECT * INTO row FROM subkit.runtime_secret_versions WHERE name=entry.name AND version=entry.version FOR UPDATE;
  IF NOT FOUND OR row.ciphertext IS DISTINCT FROM entry.expected_ciphertext OR row.iv IS DISTINCT FROM entry.expected_iv OR row.auth_tag IS DISTINCT FROM entry.expected_auth_tag THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='vault_maintenance_cas_conflict'; END IF;
  metadata_hash:=encode(public.digest((to_jsonb(row)-ARRAY['ciphertext','iv','auth_tag'])::text,'sha256'),'hex');
  payload:=array_append(payload,ROW(row.name,row.version,row.tenant_id,row.ciphertext,row.iv,row.auth_tag,metadata_hash)::subkit.vault_cipher_snapshot);
  total:=total+octet_length(row.ciphertext)+octet_length(row.iv)+octet_length(row.auth_tag)+COALESCE(octet_length(entry.replacement_ciphertext),0)+COALESCE(octet_length(entry.replacement_iv),0)+COALESCE(octet_length(entry.replacement_auth_tag),0);
  IF total>134217728 THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='vault_maintenance_page_too_large'; END IF;
  IF entry.unchanged THEN
   IF entry.replacement_ciphertext IS NOT NULL OR entry.replacement_iv IS NOT NULL OR entry.replacement_auth_tag IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_envelope_invalid'; END IF;
  ELSIF entry.replacement_ciphertext IS NULL OR entry.replacement_iv IS NULL OR entry.replacement_auth_tag IS NULL OR octet_length(entry.replacement_ciphertext)<>octet_length(row.ciphertext) OR octet_length(entry.replacement_iv)<>12 OR octet_length(entry.replacement_auth_tag)<>16 OR entry.replacement_iv=row.iv OR EXISTS(SELECT 1 FROM subkit.runtime_secret_versions v WHERE v.iv=entry.replacement_iv) OR (row.ciphertext,row.iv,row.auth_tag) IS NOT DISTINCT FROM (entry.replacement_ciphertext,entry.replacement_iv,entry.replacement_auth_tag) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='vault_maintenance_envelope_invalid'; END IF;
 END LOOP;
 IF encode(public.digest(to_jsonb(payload)::text,'sha256'),'hex')<>p_page_sha256 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='vault_maintenance_cas_conflict'; END IF;
 UPDATE subkit.runtime_config_state SET vault_maintenance_context=c||jsonb_build_object('applying',true) WHERE key='runtime';
 FOREACH entry IN ARRAY p_rows LOOP
  IF entry.unchanged THEN unchanged_counted:=unchanged_counted+1;
  ELSE
   UPDATE subkit.runtime_secret_versions SET ciphertext=entry.replacement_ciphertext,iv=entry.replacement_iv,auth_tag=entry.replacement_auth_tag WHERE name=entry.name AND version=entry.version;
   changed:=changed+1;
  END IF;
 END LOOP;
 result_key_epoch:=s.master_key_epoch;
 IF s.master_key_digest IS DISTINCT FROM c->>'target_digest' THEN result_key_epoch:=result_key_epoch+1; END IF;
 receipt_hex:=substr(encode(public.digest('offline-vault:'||p_operation::text||':'||(c->>'page_number'),'sha256'),'hex'),1,32);
 receipt:=overlay(overlay(receipt_hex placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid;
 IF changed>0 OR (p_finish AND result_key_epoch<>s.master_key_epoch) THEN
  INSERT INTO subkit.audit_log(id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,result,reason,trace_id,metadata) VALUES(receipt,'00000000-0000-0000-0000-000000000000','system',NULL,'secret.master_key_rewrapped','runtime_secret',p_operation::text,'success','offline_key_rewrap','',jsonb_build_object('operation_id',p_operation,'page_number',(c->>'page_number')::integer,'replaced_count',changed,'unchanged_count',unchanged_counted,'source_epoch',s.master_key_epoch,'target_epoch',result_key_epoch,'source_key_digest',s.master_key_digest,'target_key_digest',c->>'target_digest','evidence_sha256',c->>'evidence_sha256','page_sha256',p_page_sha256,'binding_sha256',c->>'binding_sha256'));
 ELSE receipt:=NULL;
 END IF;
 IF p_finish THEN
  UPDATE subkit.runtime_config_state SET master_key_epoch=result_key_epoch,master_key_digest=c->>'target_digest',vault_maintenance_context=NULL WHERE key='runtime';
 ELSE
  UPDATE subkit.runtime_config_state SET vault_maintenance_context=(c-ARRAY['page_sha256','row_count','tail_name','tail_version','has_more'])||jsonb_build_object('after_name',c->'tail_name','after_version',c->'tail_version','pending',false,'applying',false,'page_number',(c->>'page_number')::integer+1) WHERE key='runtime';
 END IF;
 RETURN QUERY SELECT changed,unchanged_counted,result_key_epoch,receipt;
END $$;
REVOKE ALL ON FUNCTION subkit.vault_maintenance_apply(uuid,text,subkit.vault_cipher_replacement[],boolean) FROM PUBLIC`,
    ownerGuard,
  ];
  return `${parts.join("\n--> statement-breakpoint\n")}\n`;
}
