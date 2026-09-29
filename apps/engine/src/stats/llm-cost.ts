// Money for LLM calls, read one way on every surface.
//
// `GET /v1/stats/llm`, `GET /v1/executions/{id}/cost` and the MCP tool
// `get_llm_usage` each used to hold their own copy of "look up the tenant's
// prices, apply them per model". A copy that drifted — a surface pricing
// without the built-in catalog, or with another currency default — would tell
// one reader "prices not configured" about a model another reader sees priced.
// The rates come from here: the built-in catalog, overridden per model by the
// tenant's `tokens.prices`.

import { type SQL, sql } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { type BucketUnit, WINDOW_CAP_MS } from "../http/routes/stats/bucket-window.ts";
import {
  type CostResult,
  effectiveModelPrices,
  longContextThresholds,
  MODEL_PRICE_CATALOG_CURRENCY,
  type PricedTokens,
  priceCalls,
  type SourcedModelPrice,
} from "../llm/index.ts";
import { buildWhere, type LlmStatsParams } from "./aggregate-llm.ts";

/**
 * A bucket unit whose window cap covers `from`–`to`. Only the time series
 * depends on it; the totals a price is computed from are the same for any.
 */
export function statsBucketFor(from: Date, to: Date): BucketUnit {
  const span = to.getTime() - from.getTime();
  const unit = (["day", "month", "year"] as const).find((u) => span <= WINDOW_CAP_MS[u]);
  return unit ?? "year";
}

/** The tenant's rates in force now, and the currency they are quoted in. */
function tenantRates(tenantId: string): { prices: SourcedModelPrice[]; currency: string } {
  const tokens = getConfig(tenantId).tokens;
  return {
    prices: effectiveModelPrices(tokens ?? {}),
    currency: tokens?.currency ?? MODEL_PRICE_CATALOG_CURRENCY,
  };
}

/** Price a set of per-model token sums at the tenant's rates in force now. */
export function priceForTenant(tenantId: string, calls: readonly PricedTokens[]): CostResult {
  const { prices, currency } = tenantRates(tenantId);
  return priceCalls(calls, prices, currency);
}

/**
 * Token sums of the `llm_usage` rows matching `where`, grouped by model and by
 * which long-context thresholds each call's prompt exceeded — one SQL pass.
 *
 * `llm_usage` holds one row per provider call (one agent step), and a vendor
 * bills a long prompt's call at its long-context rate in full. So the split
 * has to happen per row, before summing: a sum of two 150k prompts is past a
 * 200k threshold although neither call was. Grouping by the count of
 * thresholds a row exceeds puts every group wholly on one side of every
 * model's threshold, whatever the model, and each group states the bound its
 * calls all exceed (`prompt_tokens_exceed`) for `priceCalls` to decide on.
 */
export async function readPricedTokens(
  db: Db,
  where: SQL,
  thresholds: readonly number[],
): Promise<PricedTokens[]> {
  const tier =
    thresholds.length === 0
      ? sql`0`
      : sql.join(
          thresholds.map(
            (t) => sql`(case when coalesce(llm_usage.prompt_tokens, 0) > ${t} then 1 else 0 end)`,
          ),
          sql` + `,
        );
  const rows = (
    await db.execute(sql`
      select
        llm_usage.model as model,
        (${tier})::int as tier,
        count(*)::int as calls,
        coalesce(sum(llm_usage.prompt_tokens), 0)::float8 as prompt,
        coalesce(sum(llm_usage.completion_tokens), 0)::float8 as completion,
        coalesce(sum(llm_usage.cache_read_tokens), 0)::float8 as cache_read,
        coalesce(sum(llm_usage.cache_creation_tokens), 0)::float8 as cache_creation
      from llm_usage
      where ${where}
      group by 1, 2
    `)
  ).rows as Record<string, unknown>[];
  return rows.map((row) => {
    const k = Number(row.tier ?? 0);
    return {
      model: row.model == null ? "" : String(row.model),
      calls: Number(row.calls ?? 0),
      prompt_tokens: Number(row.prompt ?? 0),
      completion_tokens: Number(row.completion ?? 0),
      cache_read_tokens: Number(row.cache_read ?? 0),
      cache_creation_tokens: Number(row.cache_creation ?? 0),
      // Tier k: every call exceeded the k lowest thresholds and no higher one.
      // Tier 0 exceeded none, which `-1` states without claiming any threshold.
      prompt_tokens_exceed: k > 0 ? (thresholds[k - 1] ?? -1) : -1,
    };
  });
}

/**
 * The cost of the `llm_usage` rows matching `where`, at the tenant's rates in
 * force now, split at every long-context threshold those rates carry.
 */
export async function readLlmCost(db: Db, tenantId: string, where: SQL): Promise<CostResult> {
  const { prices, currency } = tenantRates(tenantId);
  const rows = await readPricedTokens(db, where, longContextThresholds(prices));
  return priceCalls(rows, prices, currency);
}

/**
 * The priced spend of one window, under the same filters the caller counted
 * tokens with.
 *
 * Asked as its own by-model rollup, because a price needs a model and the
 * caller's grouping is usually not by model: pricing a flow or a user rollup
 * would multiply its tokens by whichever model happened to be named first.
 */
export function readLlmWindowCost(
  db: Db,
  params: Omit<LlmStatsParams, "groupBy">,
): Promise<CostResult> {
  return readLlmCost(db, params.tenantId, buildWhere(params));
}
