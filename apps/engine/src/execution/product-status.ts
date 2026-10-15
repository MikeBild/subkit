import { and, eq, isNull } from "drizzle-orm";
import type { ProductConfig } from "../config/schema.ts";
import { loadConnectorSystem } from "../connectors/system.ts";
import type { Db } from "../db/client.ts";
import { workflowExecutionAuthorities, workflows, workflowVersions } from "../db/schema/index.ts";
import { authorityLive } from "../workflows/authority-live.ts";
import { executableDefinition } from "../workflows/stored-definition.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import { type CallerUsage, callerUsage } from "./caller-budget.ts";

export interface ProductContext {
  tenant_id: string;
  principal_id: string;
  product_id: string;
  product: ProductConfig;
}

export interface ProductHealth {
  ok: boolean;
  version: "1";
  model: { id: null; status: "unchecked" };
  key: "present" | "missing";
}

async function activeAssistant(
  db: Db,
  context: ProductContext,
): Promise<{ versionId: string; def: WorkflowDef } | null> {
  const [row] = await db
    .select({ versionId: workflows.current_version_id, dag: workflowVersions.dag })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.tenant_id, workflows.tenant_id),
        eq(workflowVersions.id, workflows.current_version_id),
      ),
    )
    .where(
      and(
        eq(workflows.tenant_id, context.tenant_id),
        eq(workflows.id, context.product.assistant_workflow_id),
        eq(workflows.lifecycle, "active"),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (!row?.versionId) return null;
  const def = executableDefinition(row.dag);
  return def.product_id === context.product_id ? { versionId: row.versionId, def } : null;
}

async function credentialsPresent(
  db: Db,
  tenant_id: string,
  def: WorkflowDef,
  environment: "dev" | "prod",
): Promise<boolean> {
  const connectorIds = [
    ...new Set(
      def.steps.flatMap((step) =>
        step.kind === "request" && step.connector_id ? [step.connector_id] : [],
      ),
    ),
  ];
  for (const connectorId of connectorIds) {
    const system = await loadConnectorSystem(tenant_id, connectorId, environment, db);
    if (!system) return false;
    if (system.connector.auth_type === "none") continue;
    const metadata = await system.getAuthorityMetadata();
    if (!metadata.available || !metadata.binding.primary) return false;
  }
  return true;
}

export async function productBudget(db: Db, context: ProductContext): Promise<CallerUsage | null> {
  const assistant = await activeAssistant(db, context);
  const guard = assistant?.def.execution_guards?.caller_daily_limit;
  if (!guard || guard.bucket !== context.product.budget_bucket) return null;
  return db.transaction((tx) =>
    callerUsage(tx, {
      tenant_id: context.tenant_id,
      bucket: guard.bucket,
      principal_id: context.principal_id,
      limit: guard.limit,
      tz: guard.tz,
    }),
  );
}

export async function productHealth(db: Db, context: ProductContext): Promise<ProductHealth> {
  const assistant = await activeAssistant(db, context);
  let authorityReady = false;
  let key: ProductHealth["key"] = "missing";
  if (assistant) {
    const [authority] = await db
      .select({ id: workflowExecutionAuthorities.id })
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, context.tenant_id),
          eq(workflowExecutionAuthorities.workflow_id, context.product.assistant_workflow_id),
          eq(workflowExecutionAuthorities.workflow_version_id, assistant.versionId),
          eq(
            workflowExecutionAuthorities.execution_environment,
            context.product.execution_environment,
          ),
          authorityLive(),
        ),
      )
      .limit(1);
    authorityReady = Boolean(authority);
    key = (await credentialsPresent(
      db,
      context.tenant_id,
      assistant.def,
      context.product.execution_environment,
    ))
      ? "present"
      : "missing";
  }
  return {
    ok: Boolean(assistant) && authorityReady && key === "present",
    version: "1",
    model: { id: null, status: "unchecked" },
    key,
  };
}
