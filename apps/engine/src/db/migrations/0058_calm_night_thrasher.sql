ALTER TABLE "tool_approvals" ADD COLUMN "claimed_execution_id" uuid;
--> statement-breakpoint
CREATE FUNCTION "subkit"."guard_tool_approval_execution"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, subkit AS $$
DECLARE item record;
BEGIN
  IF jsonb_typeof(NEW.tool_approval_dispatches) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'single-use dispatch counters must be an object' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.tool_approval_dispatches <> '{}'::jsonb THEN
      RAISE EXCEPTION 'new executions cannot contain dispatch reservations' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tool_approval_id IS NULL AND NEW.tool_approval_dispatches <> '{}'::jsonb THEN
    RAISE EXCEPTION 'dispatch reservations require an approval' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT key, value FROM jsonb_each(NEW.tool_approval_dispatches) LOOP
    IF jsonb_typeof(item.value) IS DISTINCT FROM 'object' OR
       jsonb_typeof(item.value->'step_key') IS DISTINCT FROM 'string' OR
       length(item.value->>'step_key') = 0 OR
       jsonb_typeof(item.value->'digest') IS DISTINCT FROM 'string' OR
       (item.value->>'digest') !~ '^[a-f0-9]{64}$' OR
       jsonb_typeof(item.value->'attempts') IS DISTINCT FROM 'number' OR
       (item.value->>'attempts') !~ '^([1-9]|1[0-9]|20)$' THEN
      RAISE EXCEPTION 'invalid single-use dispatch reservation' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NEW.tool_approval_id IS DISTINCT FROM OLD.tool_approval_id THEN
    RAISE EXCEPTION 'execution tool approval is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.tool_approval_id IS NOT NULL THEN
    IF ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id, NEW.execution_mode,
           NEW.source_kind, NEW.source_ref, NEW.input, NEW.idempotency_key, NEW.parent_execution_id,
           NEW.request_source, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id, OLD.execution_mode,
           OLD.source_kind, OLD.source_ref, OLD.input, OLD.idempotency_key, OLD.parent_execution_id,
           OLD.request_source, OLD.created_at) THEN
      RAISE EXCEPTION 'single-use execution boundary is immutable' USING ERRCODE = '23514';
    END IF;
    FOR item IN SELECT key, value FROM jsonb_each(OLD.tool_approval_dispatches) LOOP
      IF NOT (NEW.tool_approval_dispatches ? item.key) OR
        NEW.tool_approval_dispatches->item.key->>'digest' IS DISTINCT FROM item.value->>'digest' OR
        NEW.tool_approval_dispatches->item.key->>'step_key' IS DISTINCT FROM item.value->>'step_key' OR
        (NEW.tool_approval_dispatches->item.key->>'attempts')::integer < (item.value->>'attempts')::integer THEN
        RAISE EXCEPTION 'single-use dispatch counters cannot decrease' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tool_approval_execution_guard" BEFORE INSERT OR UPDATE ON "subkit"."executions"
FOR EACH ROW EXECUTE FUNCTION "subkit"."guard_tool_approval_execution"();
--> statement-breakpoint
CREATE FUNCTION "subkit"."guard_approval_execution_link"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, subkit AS $$
BEGIN
  IF OLD.claimed_execution_id IS NOT NULL AND
     NEW.claimed_execution_id IS DISTINCT FROM OLD.claimed_execution_id THEN
    RAISE EXCEPTION 'approval execution link is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "approval_execution_link_guard" BEFORE UPDATE ON "subkit"."tool_approvals"
FOR EACH ROW EXECUTE FUNCTION "subkit"."guard_approval_execution_link"();
