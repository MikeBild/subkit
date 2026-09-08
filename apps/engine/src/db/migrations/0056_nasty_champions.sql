ALTER TABLE "subkit"."executions" ADD COLUMN "hold_writes" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "subkit"."guard_preparation_execution"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, subkit AS $$
BEGIN
  IF NEW.hold_writes AND NEW.execution_authority_id IS NOT NULL THEN
    RAISE EXCEPTION 'a preparation run cannot consume a live authority' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.hold_writes IS DISTINCT FROM OLD.hold_writes THEN
      RAISE EXCEPTION 'execution preparation mode is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.hold_writes AND
       ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id, NEW.execution_mode,
           NEW.source_kind, NEW.source_ref, NEW.input, NEW.idempotency_key, NEW.parent_execution_id,
           NEW.request_source, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id, OLD.execution_mode,
           OLD.source_kind, OLD.source_ref, OLD.input, OLD.idempotency_key, OLD.parent_execution_id,
           OLD.request_source, OLD.created_at) THEN
      RAISE EXCEPTION 'preparation execution boundary is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "preparation_execution_guard"
BEFORE INSERT OR UPDATE ON "subkit"."executions"
FOR EACH ROW EXECUTE FUNCTION "subkit"."guard_preparation_execution"();
