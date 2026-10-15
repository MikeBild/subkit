import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import { type ProductContext, productBudget, productHealth } from "../../execution/index.ts";
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

function productOf(principal: ResolvedPrincipal): ProductContext {
  const id = principal.product_id;
  const product = id && isConfigLoaded() ? getConfig().products[id] : undefined;
  if (!id || !product) throw new NotFoundError("product");
  return { tenant_id: principal.tenant_id, principal_id: principal.id, product_id: id, product };
}

export function registerProductStatusRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/budget", requirePermission("execution:read"));
  app.use("/v1/health", requirePermission("execution:read"));

  app.openapi(budgetRoute, async (c) => {
    const usage = await productBudget(c.get("db"), productOf(requireAuth(c)));
    if (!usage) throw new NotFoundError("budget");
    return c.json(usage, 200);
  });

  app.openapi(healthRoute, async (c) => {
    return c.json(await productHealth(c.get("db"), productOf(requireAuth(c))), 200);
  });
}
