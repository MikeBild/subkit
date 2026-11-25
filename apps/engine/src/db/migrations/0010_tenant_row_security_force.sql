DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."vault_items";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_row_scope" ON "subkit"."vault_items";
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."vault_items" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."vault_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."vault_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."tool_approvals";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_row_scope" ON "subkit"."tool_approvals";
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."tool_approvals" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."tool_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."tool_approvals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."webhooks_inbound";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_row_scope" ON "subkit"."webhooks_inbound";
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."webhooks_inbound" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."webhooks_inbound" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."webhooks_inbound" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."subscriptions";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_row_scope" ON "subkit"."subscriptions";
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."subscriptions" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."chat_workspaces";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_row_scope" ON "subkit"."chat_workspaces";
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."chat_workspaces" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."chat_workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."chat_workspaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."cockpit_push_keys";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_row_scope" ON "subkit"."cockpit_push_keys";
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."cockpit_push_keys" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."cockpit_push_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."cockpit_push_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."cockpit_push_subscriptions";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_row_scope" ON "subkit"."cockpit_push_subscriptions";
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."cockpit_push_subscriptions" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."cockpit_push_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."cockpit_push_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."workflow_run_state";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_row_scope" ON "subkit"."workflow_run_state";
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."workflow_run_state" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."workflow_run_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."workflow_run_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."auth_provider_configs";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_row_scope" ON "subkit"."auth_provider_configs";
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."auth_provider_configs" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."auth_provider_configs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."auth_provider_configs" FORCE ROW LEVEL SECURITY;
