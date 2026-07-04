-- Collapse duplicate schedule rows to one per workflow, then enforce it.
--
-- The reconciler fires each `workflows_schedules` row independently, so
-- repeated `create_schedule` calls for the same workflow (each landing on a
-- slightly different minute) accumulated rows that each fired — one logical
-- schedule became N real runs. Keep the most-recently-updated row per
-- (tenant_id, workflow_id); id breaks an updated_at tie so exactly one
-- survives. Then swap the plain index for a unique one so neither write path
-- can re-accumulate duplicates.
DELETE FROM "workflows_schedules" s
USING "workflows_schedules" keep
WHERE s."tenant_id" = keep."tenant_id"
  AND s."workflow_id" = keep."workflow_id"
  AND (
    keep."updated_at" > s."updated_at"
    OR (keep."updated_at" = s."updated_at" AND keep."id" > s."id")
  );
--> statement-breakpoint
DROP INDEX IF EXISTS "workflows_schedules_tenant_workflow_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflows_schedules_tenant_workflow_uidx"
  ON "workflows_schedules" ("tenant_id", "workflow_id");
