-- Distinguish workflow-trigger-bound inbound rows from direct-CRUD ones.
--
-- The audit surface differentiates these in the `webhook.trigger.fired`
-- vs `webhook.inbound.received` actions: a fired event from a workflow
-- trigger is a deeper signal (the binding lives inside the workflow
-- definition, not in operator-managed CRUD), and compliance dashboards
-- want to filter the two without joining across the workflow def.
--
-- Existing rows predating the trigger-binding path were all created via the direct-CRUD path
-- (`POST /v1/webhooks/inbound`); the default of `'crud'` mirrors that.
-- The reverse-bind helper (`bindFromWorkflow`) writes `'trigger'`.

ALTER TABLE "webhooks_inbound"
  ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'crud';
--> statement-breakpoint
