ALTER TABLE "executions" ADD COLUMN "authority_root_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "authority_call_path" jsonb;--> statement-breakpoint
CREATE INDEX "executions_authority_link_idx" ON "executions" USING btree ("tenant_id","authority_root_execution_id");--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_authority_link_shape_check" CHECK (("executions"."authority_root_execution_id" IS NULL) = ("executions"."authority_call_path" IS NULL) AND
      ("executions"."authority_root_execution_id" IS NULL OR (
        "executions"."execution_authority_id" IS NULL AND "executions"."tool_approval_id" IS NULL AND
        NOT "executions"."hold_writes" AND "executions"."source_kind" = 'saved' AND
        "executions"."workflow_id" IS NOT NULL AND "executions"."workflow_version_id" IS NOT NULL AND
        "executions"."parent_execution_id" IS NOT DISTINCT FROM "executions"."authority_root_execution_id" AND
        jsonb_typeof("executions"."authority_call_path") = 'array' AND
        jsonb_array_length("executions"."authority_call_path") >= 1)));--> statement-breakpoint
CREATE FUNCTION "subkit"."guard_execution_authority_link"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, subkit AS $$
BEGIN
  -- A run may not acquire, drop or move its link to a root's approval. Without
  -- this, an unapproved run could be pointed at an approved one after the fact
  -- and borrow its permission on the next dispatch.
  IF NEW.authority_root_execution_id IS DISTINCT FROM OLD.authority_root_execution_id
     OR NEW.authority_call_path IS DISTINCT FROM OLD.authority_call_path THEN
    RAISE EXCEPTION 'authority link cannot be attached, removed or replaced after the run is created' USING ERRCODE = '23514';
  END IF;
  -- What the root's approval was measured against must stay put for a linked
  -- run, exactly as it does for one holding its own approval.
  IF OLD.authority_root_execution_id IS NOT NULL AND
     ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id, NEW.execution_mode,
         NEW.source_kind, NEW.source_ref, NEW.input, NEW.idempotency_key, NEW.parent_execution_id,
         NEW.request_source, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id, OLD.execution_mode,
         OLD.source_kind, OLD.source_ref, OLD.input, OLD.idempotency_key, OLD.parent_execution_id,
         OLD.request_source, OLD.created_at) THEN
    RAISE EXCEPTION 'linked execution boundary is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "execution_authority_link_guard"
BEFORE UPDATE ON "subkit"."executions"
FOR EACH ROW EXECUTE FUNCTION "subkit"."guard_execution_authority_link"();
