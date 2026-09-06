ALTER TABLE "subkit"."executions" ADD COLUMN "execution_authority_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_authorities_execution_binding_key" ON "subkit"."workflow_execution_authorities" USING btree ("tenant_id","id","workflow_id","workflow_version_id","execution_environment");
--> statement-breakpoint
ALTER TABLE "subkit"."executions" ADD CONSTRAINT "executions_exact_authority_fk" FOREIGN KEY ("tenant_id","execution_authority_id","workflow_id","workflow_version_id","execution_mode") REFERENCES "subkit"."workflow_execution_authorities"("tenant_id","id","workflow_id","workflow_version_id","execution_environment") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "executions_authority_idx" ON "subkit"."executions" USING btree ("tenant_id","execution_authority_id");
--> statement-breakpoint
ALTER TABLE "subkit"."executions" ADD CONSTRAINT "executions_authority_saved_check" CHECK ("executions"."execution_authority_id" IS NULL OR
      ("executions"."source_kind" = 'saved' AND "executions"."workflow_id" IS NOT NULL AND "executions"."workflow_version_id" IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION "subkit"."reserve_execution_authority"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, subkit AS $$
BEGIN
  IF NEW.execution_authority_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status <> 'queued' THEN
    RAISE EXCEPTION 'authorized executions must be admitted as queued' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM "subkit"."workflows"
   WHERE id = NEW.workflow_id AND tenant_id = NEW.tenant_id
     AND current_version_id = NEW.workflow_version_id
     AND lifecycle = 'active' AND deleted_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution authority requires the exact active workflow version' USING ERRCODE = '23514';
  END IF;
  UPDATE "subkit"."workflow_execution_authorities"
     SET reserved_runs = reserved_runs + 1
   WHERE id = NEW.execution_authority_id AND tenant_id = NEW.tenant_id
     AND workflow_id = NEW.workflow_id AND workflow_version_id = NEW.workflow_version_id
     AND execution_environment = NEW.execution_mode
     AND revoked_at IS NULL AND valid_from <= clock_timestamp()
     AND valid_until > clock_timestamp() AND reserved_runs < max_runs;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution authority is unavailable or exhausted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "execution_authority_reservation"
BEFORE INSERT ON "subkit"."executions"
FOR EACH ROW EXECUTE FUNCTION "subkit"."reserve_execution_authority"();
--> statement-breakpoint
CREATE FUNCTION "subkit"."guard_execution_authority_binding"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, subkit AS $$
BEGIN
  IF NEW.execution_authority_id IS DISTINCT FROM OLD.execution_authority_id THEN
    RAISE EXCEPTION 'execution authority cannot be attached, removed or replaced after admission' USING ERRCODE = '23514';
  END IF;
  IF OLD.execution_authority_id IS NOT NULL AND
     ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id, NEW.execution_mode,
         NEW.source_kind, NEW.source_ref, NEW.input, NEW.idempotency_key, NEW.parent_execution_id,
         NEW.request_source, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id, OLD.execution_mode,
         OLD.source_kind, OLD.source_ref, OLD.input, OLD.idempotency_key, OLD.parent_execution_id,
         OLD.request_source, OLD.created_at) THEN
    RAISE EXCEPTION 'authorized execution boundary is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "execution_authority_binding_guard"
BEFORE UPDATE ON "subkit"."executions"
FOR EACH ROW EXECUTE FUNCTION "subkit"."guard_execution_authority_binding"();
