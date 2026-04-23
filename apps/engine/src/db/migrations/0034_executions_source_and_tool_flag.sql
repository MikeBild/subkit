-- Hart-Cut: executions-Tabelle wird definition-driven.
--
-- Definition-driven execution model: eine Execution kann jetzt aus
-- drei Quellen stammen:
--   saved → gespeicherter Workflow mit workflow_id + workflow_version_id
--   draft → inline-übergebene WorkflowDef ohne Persistenz-Zwang
--   step  → Einzelstep-Ausführung für direkte Testläufe
--
-- Für draft/step sind workflow_id und workflow_version_id NULL. Ein
-- CHECK-Constraint verhindert, dass saved-Runs diese Felder verlieren.
--
-- workflows.is_tool kodifiziert die Produktregel: Ein gespeicherter
-- Workflow mit is_tool=true erscheint im MCP-Toolkatalog als Produkt-Tool.
-- Autoring-Drafts (no current_version_id) sind ohnehin nicht listbar.

ALTER TABLE "executions"
  ALTER COLUMN "workflow_id" DROP NOT NULL,
  ALTER COLUMN "workflow_version_id" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "executions"
  ADD COLUMN "source_kind" text NOT NULL DEFAULT 'saved';
--> statement-breakpoint

ALTER TABLE "executions"
  ADD COLUMN "source_ref" jsonb;
--> statement-breakpoint

ALTER TABLE "executions"
  ADD CONSTRAINT "executions_source_kind_check"
  CHECK ("source_kind" IN ('saved', 'draft', 'step'));
--> statement-breakpoint

ALTER TABLE "executions"
  ADD CONSTRAINT "executions_saved_has_workflow"
  CHECK (
    "source_kind" <> 'saved'
    OR ("workflow_id" IS NOT NULL AND "workflow_version_id" IS NOT NULL)
  );
--> statement-breakpoint

CREATE INDEX "executions_tenant_source_kind_idx"
  ON "executions" ("tenant_id", "source_kind");
--> statement-breakpoint

ALTER TABLE "workflows"
  ADD COLUMN "is_tool" boolean NOT NULL DEFAULT true;
