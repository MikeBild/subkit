ALTER TABLE "workflow_execution_authorities" DROP CONSTRAINT "workflow_authorities_window_check";--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" DROP CONSTRAINT "workflow_authorities_run_limit_check";--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" DROP CONSTRAINT "workflow_authorities_revocation_check";--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ALTER COLUMN "valid_until" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ALTER COLUMN "max_runs" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ALTER COLUMN "max_runs" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD COLUMN "inherited_from" uuid;--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD COLUMN "approved_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "authority_growth" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD CONSTRAINT "workflow_authorities_inherited_from_fk" FOREIGN KEY ("tenant_id","inherited_from") REFERENCES "workflow_execution_authorities"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_authorities_inherited_from_key" ON "workflow_execution_authorities" USING btree ("tenant_id","inherited_from") WHERE "workflow_execution_authorities"."inherited_from" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD CONSTRAINT "workflow_authorities_window_check" CHECK ("workflow_execution_authorities"."valid_until" IS NULL OR "workflow_execution_authorities"."valid_until" > "workflow_execution_authorities"."valid_from");--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD CONSTRAINT "workflow_authorities_run_limit_check" CHECK ("workflow_execution_authorities"."reserved_runs" >= 0 AND ("workflow_execution_authorities"."max_runs" IS NULL OR ("workflow_execution_authorities"."max_runs" > 0 AND "workflow_execution_authorities"."reserved_runs" <= "workflow_execution_authorities"."max_runs")));--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD CONSTRAINT "workflow_authorities_revocation_check" CHECK (("workflow_execution_authorities"."revoked_at" IS NULL AND "workflow_execution_authorities"."revoked_by" IS NULL AND "workflow_execution_authorities"."superseded_by" IS NULL) OR ("workflow_execution_authorities"."revoked_at" IS NOT NULL AND ("workflow_execution_authorities"."revoked_by" IS NOT NULL OR "workflow_execution_authorities"."superseded_by" IS NOT NULL)));--> statement-breakpoint
-- An approval may be open-ended: NULL `valid_until` is no end date, NULL
-- `max_runs` no run limit. Runs are still counted. An approval may also be
-- continued by a newer version whose effect boundary did not grow; the parent
-- then ends (`superseded_by`) in the same transaction. The boundary of an
-- approval stays immutable, and an ended approval stays ended.
CREATE OR REPLACE FUNCTION "subkit"."guard_workflow_execution_authority"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, subkit AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.workflow_version_id,
         NEW.effect_manifest_digest, NEW.effect_manifest, NEW.execution_environment,
         NEW.target_constraints, NEW.valid_from, NEW.valid_until, NEW.max_runs,
         NEW.created_by, NEW.created_at, NEW.inherited_from, NEW.approved_manifest)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.workflow_version_id,
         OLD.effect_manifest_digest, OLD.effect_manifest, OLD.execution_environment,
         OLD.target_constraints, OLD.valid_from, OLD.valid_until, OLD.max_runs,
         OLD.created_by, OLD.created_at, OLD.inherited_from, OLD.approved_manifest) THEN
    RAISE EXCEPTION 'workflow execution authority boundary is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.reserved_runs < OLD.reserved_runs THEN
    RAISE EXCEPTION 'workflow execution reservations cannot be reset' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND
     ROW(NEW.revoked_at, NEW.revoked_by, NEW.reserved_runs, NEW.superseded_by)
       IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revoked_by, OLD.reserved_runs, OLD.superseded_by) THEN
    RAISE EXCEPTION 'revoked workflow execution authority is terminal' USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'a continued workflow execution authority must end' USING ERRCODE = '23514';
  END IF;
  IF NEW.reserved_runs > OLD.reserved_runs AND
     (NEW.revoked_at IS NOT NULL OR clock_timestamp() < NEW.valid_from OR
      (NEW.valid_until IS NOT NULL AND clock_timestamp() >= NEW.valid_until)) THEN
    RAISE EXCEPTION 'workflow execution authority is outside its live window' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subkit"."reserve_execution_authority"()
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
     AND (valid_until IS NULL OR valid_until > clock_timestamp())
     AND (max_runs IS NULL OR reserved_runs < max_runs);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution authority is unavailable or exhausted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;