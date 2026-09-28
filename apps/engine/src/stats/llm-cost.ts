// Money for LLM calls, read one way on every surface.
//
// `GET /v1/stats/llm`, `GET /v1/executions/{id}/cost` and the MCP tool
// `get_llm_usage` each used to hold their own copy of "look up the tenant's
// prices, apply them per model". A copy that drifted — a surface pricing
// without the built-in catalog, or with another currency default — would tell
// one reader "prices not configured" about a model another reader sees priced.
// The rates come from here: the built-in catalog, overridden per model by the
// tenant's `tokens.prices`.

import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { type BucketUnit, WINDOW_CAP_MS } from "../http/routes/stats/bucket-window.ts";
import {
  type CostResult,
  effectiveModelPrices,
  MODEL_PRICE_CATALOG_CURRENCY,
  type PricedTokens,
  priceCalls,
} from "../llm/index.ts";
import { aggregateLlm, type LlmStatsParams } from "./aggregate-llm.ts";

/**
 * A bucket unit whose window cap covers `from`–`to`. Only the time series
 * depends on it; the totals a price is computed from are the same for any.
 */
export function statsBucketFor(from: Date, to: Date): BucketUnit {
  const span = to.getTime() - from.getTime();
  const unit = (["day", "month", "year"] as const).find((u) => span <= WINDOW_CAP_MS[u]);
  return unit ?? "year";
}

/** Price a set of per-model token sums at the tenant's rates in force now. */
export function priceForTenant(tenantId: string, calls: readonly PricedTokens[]): CostResult {
  const tokens = getConfig(tenantId).tokens;
  return priceCalls(
    calls,
    effectiveModelPrices(tokens ?? {}),
    tokens?.currency ?? MODEL_PRICE_CATALOG_CURRENCY,
  );
}

/**
 * The priced spend of one window, under the same filters the caller counted
 * tokens with.
 *
 * Asked as its own by-model rollup, because a price needs a model and the
 * caller's grouping is usually not by model: pricing a flow or a user rollup
 * would multiply its tokens by whichever model happened to be named first.
 */
export async function readLlmWindowCost(
  db: Db,
  params: Omit<LlmStatsParams, "groupBy">,
): Promise<CostResult> {
  const byModel = await aggregateLlm(db, { ...params, groupBy: ["model"] });
  return priceForTenant(
    params.tenantId,
    byModel.groups.map((group) => ({
      model: group.key.model ?? "",
      calls: group.totals.calls,
      prompt_tokens: group.totals.tokens.prompt,
      completion_tokens: group.totals.tokens.completion,
      cache_read_tokens: group.totals.tokens.cache_read,
      cache_creation_tokens: group.totals.tokens.cache_creation,
    })),
  );
}
