import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { ErrorSchema } from "../../api/common-schemas.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import type { ProductConfig } from "../../config/schema.ts";
import { loadConnectorSystem } from "../../connectors/system.ts";
import type { Db } from "../../db/client.ts";
import {
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { callerUsage } from "../../execution/caller-budget.ts";
import { authorityLive } from "../../workflows/authority-live.ts";
import { executableDefinition } from "../../workflows/stored-definition.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const BudgetResponse = z
  .object({
    usedToday: z.number().int().nonnegative(),
    dailyLimit: z.number().int().positive(),
    day: z.string(),
    resetsAt: z.string(),
  })
  .openapi("ProductBudget");

const ProductHealthResponse = z
  .object({
    ok: z.boolean(),
    version: z.literal("1"),
    model: z.object({ id: z.null(), status: z.literal("unchecked") }),
    key: z.enum(["present", "missing"]),
  })
  .openapi("ProductHealth");

const productResponses = {
  401: { description: "Unauthenticated", content: { "application/json": { schema: ErrorSchema } } },
  404: {
    description: "The caller is not a product principal or the product is not configured",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

const budgetRoute = createRoute({
  method: "get",
  path: "/v1/budget",
  tags: ["executions"],
  summary: "Daily allowance of the authenticated product caller",
  description:
    "Reports the product assistant workflow's caller_daily_limit for the authenticated product principal. Expired reservations settle before counting.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Usage for the caller's local day",
      content: { "application/json": { schema: BudgetResponse } },
    },
    ...productResponses,
  },
});

const healthRoute = createRoute({
  method: "get",
  path: "/v1/health",
  tags: ["executions"],
  summary: "Readiness of the product assistant workflow",
  description:
    "ok is true when the product assistant workflow is active, a live execution authority exists for the product environment, and every connector it uses holds a usable credential. No secret is read.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Product readiness",
      content: { "application/json": { schema: ProductHealthResponse } },
    },
    ...productResponses,
  },
});

function productOf(principal: ResolvedPrincipal): { id: string; product: ProductConfig } {
  const id = principal.product_id;
  const product = id && isConfigLoaded() ? getConfig().products[id] : undefined;
  if (!id || !product) throw new NotFoundError("product");
  return { id, product };
}

async function activeAssistant(
  db: Db,
  tenant_id: string,
  product: ProductConfig,
  productId: string,
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
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, product.assistant_workflow_id),
        eq(workflows.lifecycle, "active"),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (!row?.versionId) return null;
  const def = executableDefinition(row.dag);
  return def.product_id === productId ? { versionId: row.versionId, def } : null;
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

export function registerProductStatusRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/budget", requirePermission("execution:read"));
  app.use("/v1/health", requirePermission("execution:read"));

  app.openapi(budgetRoute, async (c) => {
    const principal = requireAuth(c);
    const { id, product } = productOf(principal);
    const db = c.get("db");
    const assistant = await activeAssistant(db, principal.tenant_id, product, id);
    const guard = assistant?.def.execution_guards?.caller_daily_limit;
    if (!guard || guard.bucket !== product.budget_bucket) throw new NotFoundError("budget");
    const usage = await db.transaction((tx) =>
      callerUsage(tx, {
        tenant_id: principal.tenant_id,
        bucket: guard.bucket,
        principal_id: principal.id,
        limit: guard.limit,
        tz: guard.tz,
      }),
    );
    return c.json(usage, 200);
  });

  app.openapi(healthRoute, async (c) => {
    const principal = requireAuth(c);
    const { id, product } = productOf(principal);
    const db = c.get("db");
    const assistant = await activeAssistant(db, principal.tenant_id, product, id);
    let authorityReady = false;
    let key: "present" | "missing" = "missing";
    if (assistant) {
      const [authority] = await db
        .select({ id: workflowExecutionAuthorities.id })
        .from(workflowExecutionAuthorities)
        .where(
          and(
            eq(workflowExecutionAuthorities.tenant_id, principal.tenant_id),
            eq(workflowExecutionAuthorities.workflow_id, product.assistant_workflow_id),
            eq(workflowExecutionAuthorities.workflow_version_id, assistant.versionId),
            eq(workflowExecutionAuthorities.execution_environment, product.execution_environment),
            authorityLive(),
          ),
        )
        .limit(1);
      authorityReady = Boolean(authority);
      key = (await credentialsPresent(
        db,
        principal.tenant_id,
        assistant.def,
        product.execution_environment,
      ))
        ? "present"
        : "missing";
    }
    return c.json(
      {
        ok: Boolean(assistant) && authorityReady && key === "present",
        version: "1" as const,
        model: { id: null, status: "unchecked" as const },
        key,
      },
      200,
    );
  });
}
