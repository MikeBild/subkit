CREATE FUNCTION "subkit"."guard_workflow_execution_authority"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, subkit AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id,
         NEW.effect_manifest_digest, NEW.effect_manifest, NEW.execution_environment,
         NEW.target_constraints, NEW.valid_from, NEW.valid_until, NEW.max_runs,
         NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id,
         OLD.effect_manifest_digest, OLD.effect_manifest, OLD.execution_environment,
         OLD.target_constraints, OLD.valid_from, OLD.valid_until, OLD.max_runs,
         OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'workflow execution authority boundary is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.reserved_runs < OLD.reserved_runs THEN
    RAISE EXCEPTION 'workflow execution reservations cannot be reset' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND
     ROW(NEW.revoked_at, NEW.revoked_by, NEW.reserved_runs)
       IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revoked_by, OLD.reserved_runs) THEN
    RAISE EXCEPTION 'revoked workflow execution authority is terminal' USING ERRCODE = '23514';
  END IF;
  IF NEW.reserved_runs > OLD.reserved_runs AND
     (NEW.revoked_at IS NOT NULL OR clock_timestamp() < NEW.valid_from OR clock_timestamp() >= NEW.valid_until) THEN
    RAISE EXCEPTION 'workflow execution authority is outside its live window' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workflow_execution_authority_boundary_guard"
BEFORE UPDATE ON "subkit"."workflow_execution_authorities"
FOR EACH ROW EXECUTE FUNCTION "subkit"."guard_workflow_execution_authority"();
--> statement-breakpoint
CREATE FUNCTION "subkit"."guard_authorized_workflow_version"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, subkit AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.version, NEW.dag, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.version, OLD.dag, OLD.created_at)
     AND EXISTS (
       SELECT 1 FROM "subkit"."workflow_execution_authorities" authority
        WHERE authority.tenant_id = OLD.tenant_id
          AND authority.workflow_id = OLD.workflow_id
          AND authority.workflow_version_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'authorized workflow version is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "authorized_workflow_version_guard"
BEFORE UPDATE ON "subkit"."workflow_versions"
FOR EACH ROW EXECUTE FUNCTION "subkit"."guard_authorized_workflow_version"();
