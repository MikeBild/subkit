import { z } from "@hono/zod-openapi";
import { PRICE_SOURCES } from "../../llm/pricing.ts";

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

export const ExecutionCost = z
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
