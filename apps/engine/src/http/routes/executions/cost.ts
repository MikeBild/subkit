// GET /v1/executions/{id}/cost — per-execution cost + token attribution.
//
// A separate sub-resource (like /{id}/steps), not an extension of
// serializeExec: cost rolls up the `llm_usage` and `external_call_metering`
// ledgers filtered to this execution. Both ledgers now carry an
// `execution_id` attribution column (nullable; old rows read as 0).
//
// TENANT ISOLATION: the existence check on `executions` is tenant-scoped and
// runs BEFORE any aggregation — a caller can only read cost for an execution
// in their own tenant. Both aggregates keep `tenant_id` as the FIRST
// predicate and add `eq(execution_id, id)`. `llm_usage` has no monetary
// column; only `external_call_metering.cost_usd` is money.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { executions, externalCallMetering, llmUsage } from "../../../db/schema/index.ts";
import { priceForTenant } from "../../../stats/llm-cost.ts";
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
          // Which rate priced each model: SubKit's built-in catalog, or the
          // operator's own `tokens.prices` entry, which wins per model.
          price_sources: z.array(
            z.object({ model: z.string(), price_source: z.enum(["catalog", "override"]) }),
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
  // Path-specific RBAC gate: the `/:id` gate does not match `/:id/cost`.
  app.use("/v1/executions/:id/cost", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });

  app.openapi(getCostRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");

    // Tenant-isolation chokepoint: confirm the execution exists in THIS
    // tenant before aggregating either ledger. Mirrors list.ts get-by-id.
    const exec = await db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenant_id, principal.tenant_id), eq(executions.id, id)))
      .limit(1);
    if (!exec[0]) throw new NotFoundError("execution");

    // --- LLM ledger, grouped by flow -------------------------------------
    const llmRows = await db
      .select({
        flow: llmUsage.flow,
        calls: sql<number>`count(*)::int`,
        weighted_tokens: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::int`,
        prompt_tokens: sql<number>`coalesce(sum(${llmUsage.prompt_tokens}), 0)::int`,
        completion_tokens: sql<number>`coalesce(sum(${llmUsage.completion_tokens}), 0)::int`,
        cache_read_tokens: sql<number>`coalesce(sum(${llmUsage.cache_read_tokens}), 0)::int`,
        latency_ms: sql<number>`coalesce(sum(${llmUsage.latency_ms}), 0)::int`,
      })
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, principal.tenant_id), eq(llmUsage.execution_id, id)))
      .groupBy(llmUsage.flow);

    // A second grouping, by model, because a price needs one and `flow` does
    // not carry it: a single purpose can span several models at very different
    // rates. Pricing the flow rollup would multiply tokens by whichever model
    // happened to be named first.
    const modelRows = await db
      .select({
        model: llmUsage.model,
        calls: sql<number>`count(*)::int`,
        prompt_tokens: sql<number>`coalesce(sum(${llmUsage.prompt_tokens}), 0)::int`,
        completion_tokens: sql<number>`coalesce(sum(${llmUsage.completion_tokens}), 0)::int`,
        cache_read_tokens: sql<number>`coalesce(sum(${llmUsage.cache_read_tokens}), 0)::int`,
        cache_creation_tokens: sql<number>`coalesce(sum(${llmUsage.cache_creation_tokens}), 0)::int`,
      })
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, principal.tenant_id), eq(llmUsage.execution_id, id)))
      .groupBy(llmUsage.model);

    const cost = priceForTenant(
      principal.tenant_id,
      modelRows.map((r) => ({
        model: r.model ?? "",
        calls: Number(r.calls),
        prompt_tokens: Number(r.prompt_tokens),
        completion_tokens: Number(r.completion_tokens),
        cache_read_tokens: Number(r.cache_read_tokens),
        cache_creation_tokens: Number(r.cache_creation_tokens),
      })),
    );

    const by_flow = llmRows.map((r) => ({
      flow: r.flow,
      calls: Number(r.calls),
      weighted_tokens: Number(r.weighted_tokens),
      prompt_tokens: Number(r.prompt_tokens),
      completion_tokens: Number(r.completion_tokens),
      cache_read_tokens: Number(r.cache_read_tokens),
      latency_ms: Number(r.latency_ms),
    }));

    const llm = by_flow.reduce(
      (acc, f) => {
        acc.calls += f.calls;
        acc.weighted_tokens += f.weighted_tokens;
        acc.prompt_tokens += f.prompt_tokens;
        acc.completion_tokens += f.completion_tokens;
        acc.cache_read_tokens += f.cache_read_tokens;
        acc.latency_ms += f.latency_ms;
        return acc;
      },
      {
        calls: 0,
        weighted_tokens: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_read_tokens: 0,
        latency_ms: 0,
      },
    );

    // Cache-hit rate: cached input read vs. total input (fresh prompt +
    // cached read). Bounded 0–100 — the same definition the REPL footer's
    // `cache N%` chip uses, so per-run and per-conversation surfaces agree.
    const cache_input = llm.prompt_tokens + llm.cache_read_tokens;
    const cache_read_pct =
      cache_input > 0 ? Math.round((llm.cache_read_tokens / cache_input) * 1000) / 10 : 0;

    // --- external-call metering ------------------------------------------
    const extRows = await db
      .select({
        calls: sql<number>`count(*)::int`,
        cost_usd: sql<string>`coalesce(sum(${externalCallMetering.cost_usd}), 0)`,
        units: sql<number>`coalesce(sum(${externalCallMetering.units}), 0)::int`,
        latency_ms: sql<number>`coalesce(sum(${externalCallMetering.latency_ms}), 0)::int`,
      })
      .from(externalCallMetering)
      .where(
        and(
          eq(externalCallMetering.tenant_id, principal.tenant_id),
          eq(externalCallMetering.execution_id, id),
        ),
      );
    const ext = extRows[0];

    return c.json(
      {
        llm: {
          calls: llm.calls,
          weighted_tokens: llm.weighted_tokens,
          prompt_tokens: llm.prompt_tokens,
          completion_tokens: llm.completion_tokens,
          cache_read_tokens: llm.cache_read_tokens,
          cache_read_pct,
          latency_ms: llm.latency_ms,
          by_flow,
          // Money for the model calls, and a plain account of what could not
          // be priced. `llm_usage` has no monetary column, so this is computed
          // from the configured rates at read time and says so.
          cost,
        },
        external: {
          calls: Number(ext?.calls ?? 0),
          cost_usd: Number(ext?.cost_usd ?? 0),
          units: Number(ext?.units ?? 0),
          latency_ms: Number(ext?.latency_ms ?? 0),
        },
      },
      200,
    );
  });
}
