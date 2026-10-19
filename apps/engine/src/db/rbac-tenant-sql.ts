export function renderRbacTenantBoundarySql(): string {
  return `LOCK TABLE subkit.groups,subkit.users,subkit.roles,subkit.group_members,subkit.group_role_assignments IN SHARE ROW EXCLUSIVE MODE;
DELETE FROM subkit.group_members m WHERE NOT EXISTS (
 SELECT 1 FROM subkit.groups g JOIN subkit.users u ON u.tenant_id=g.tenant_id
 WHERE g.id=m.group_id AND u.id=m.user_id
);
DELETE FROM subkit.group_role_assignments a WHERE NOT EXISTS (
 SELECT 1 FROM subkit.groups g JOIN subkit.roles r ON r.tenant_id IS NULL OR r.tenant_id=g.tenant_id
 WHERE g.id=a.group_id AND r.id=a.role_id
);
ALTER TABLE subkit.group_members ADD CONSTRAINT group_members_user_id_users_id_fk FOREIGN KEY(user_id) REFERENCES subkit.users(id) ON DELETE CASCADE;
CREATE FUNCTION subkit.rbac_check_group_member_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE group_tenant uuid; user_tenant uuid;
BEGIN
 SELECT g.tenant_id,u.tenant_id INTO group_tenant,user_tenant
 FROM subkit.groups g CROSS JOIN subkit.users u
 WHERE g.id=NEW.group_id AND u.id=NEW.user_id FOR SHARE OF g,u;
 IF NOT FOUND OR group_tenant IS DISTINCT FROM user_tenant THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='rbac_group_member_tenant_mismatch',CONSTRAINT='rbac_group_member_tenant';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rbac_check_group_member_tenant BEFORE INSERT OR UPDATE ON subkit.group_members FOR EACH ROW EXECUTE FUNCTION subkit.rbac_check_group_member_tenant();
CREATE FUNCTION subkit.rbac_check_group_role_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE group_tenant uuid; role_tenant uuid;
BEGIN
 SELECT g.tenant_id,r.tenant_id INTO group_tenant,role_tenant
 FROM subkit.groups g CROSS JOIN subkit.roles r
 WHERE g.id=NEW.group_id AND r.id=NEW.role_id FOR SHARE OF g,r;
 IF NOT FOUND OR (role_tenant IS NOT NULL AND group_tenant IS DISTINCT FROM role_tenant) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='rbac_group_role_tenant_mismatch',CONSTRAINT='rbac_group_role_tenant';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rbac_check_group_role_tenant BEFORE INSERT OR UPDATE ON subkit.group_role_assignments FOR EACH ROW EXECUTE FUNCTION subkit.rbac_check_group_role_tenant();
CREATE FUNCTION subkit.rbac_check_parent_tenant_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN RETURN NEW; END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='rbac_tenant_transfer_requires_read_committed';
 END IF;
 IF TG_TABLE_NAME='groups' THEN
  IF EXISTS(SELECT 1 FROM subkit.group_members m JOIN subkit.users u ON u.id=m.user_id WHERE m.group_id=OLD.id AND u.tenant_id IS DISTINCT FROM NEW.tenant_id)
   OR EXISTS(SELECT 1 FROM subkit.group_role_assignments a JOIN subkit.roles r ON r.id=a.role_id WHERE a.group_id=OLD.id AND r.tenant_id IS NOT NULL AND r.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='rbac_group_tenant_transfer_conflict',CONSTRAINT='rbac_parent_tenant_transfer';
  END IF;
 ELSIF TG_TABLE_NAME='users' THEN
  IF EXISTS(SELECT 1 FROM subkit.group_members m JOIN subkit.groups g ON g.id=m.group_id WHERE m.user_id=OLD.id AND g.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='rbac_user_tenant_transfer_conflict',CONSTRAINT='rbac_parent_tenant_transfer';
  END IF;
 ELSIF TG_TABLE_NAME='roles' AND NEW.tenant_id IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM subkit.group_role_assignments a JOIN subkit.groups g ON g.id=a.group_id WHERE a.role_id=OLD.id AND g.tenant_id IS DISTINCT FROM NEW.tenant_id)
   OR EXISTS(SELECT 1 FROM subkit.users u WHERE u.role_id=OLD.id AND u.tenant_id IS DISTINCT FROM NEW.tenant_id)
   OR EXISTS(SELECT 1 FROM subkit.system_accounts s WHERE s.role_id=OLD.id AND s.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='rbac_role_tenant_transfer_conflict',CONSTRAINT='rbac_parent_tenant_transfer';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rbac_check_group_tenant_transfer BEFORE UPDATE OF tenant_id ON subkit.groups FOR EACH ROW EXECUTE FUNCTION subkit.rbac_check_parent_tenant_transfer();
CREATE TRIGGER rbac_check_user_tenant_transfer BEFORE UPDATE OF tenant_id ON subkit.users FOR EACH ROW EXECUTE FUNCTION subkit.rbac_check_parent_tenant_transfer();
CREATE TRIGGER rbac_check_role_tenant_transfer BEFORE UPDATE OF tenant_id ON subkit.roles FOR EACH ROW EXECUTE FUNCTION subkit.rbac_check_parent_tenant_transfer();
`;
}
