import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { loadExecutionCost } from "../../../execution/index.ts";
import { PRICE_SOURCES } from "../../../llm/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const ExecutionCostPerFlow = z
  .object({
    flow: z.string(),
    calls: z.number().int(),
    weighted_tokens: z.number().int(),
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    cache_read_tokens: z.number().int(),
    latency_ms: z.number().int(),
  })
  .openapi("ExecutionCostPerFlow");

const ExecutionCost = z
  .object({
    llm: z.object({
      calls: z.number().int(),
      weighted_tokens: z.number().int(),
      prompt_tokens: z.number().int(),
      completion_tokens: z.number().int(),
      cache_read_tokens: z.number().int(),
      cache_read_pct: z.number(),
      latency_ms: z.number().int(),
      by_flow: z.array(ExecutionCostPerFlow),
      cost: z
        .object({
          amount: z.number(),
          currency: z.string(),
          unpriced_models: z.array(z.string()),
          unpriced_calls: z.number().int(),
          cache_savings: z.number(),
          price_sources: z.array(
            z.object({ model: z.string(), price_source: z.enum(PRICE_SOURCES) }),
          ),
          rates_basis: z.literal("current"),
        })
        .openapi("ExecutionCostMoney"),
    }),
    external: z.object({
      calls: z.number().int(),
      cost_usd: z.number(),
      units: z.number().int(),
      latency_ms: z.number().int(),
    }),
  })
  .openapi("ExecutionCost");

const getCostRoute = createRoute({
  method: "get",
  path: "/v1/executions/{id}/cost",
  tags: ["executions"],
  summary: "Cost + token attribution for an execution",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ExecutionCost } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerCostRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/executions/:id/cost", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });

  app.openapi(getCostRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const cost = await loadExecutionCost(c.get("db"), principal, id);
    if (!cost) throw new NotFoundError("execution");
    return c.json(cost, 200);
  });
}
