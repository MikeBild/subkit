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
import {
  buildWhere,
  dimColumn,
  type LlmGroupDim,
  type LlmStatsParams,
  llmFromClause,
} from "./aggregate-llm.ts";

export function statsBucketFor(from: Date, to: Date): BucketUnit {
  const span = to.getTime() - from.getTime();
  const unit = (["day", "month", "year"] as const).find((u) => span <= WINDOW_CAP_MS[u]);
  return unit ?? "year";
}

function tenantRates(tenantId: string): { prices: SourcedModelPrice[]; currency: string } {
  const tokens = getConfig(tenantId).tokens;
  return {
    prices: effectiveModelPrices(tokens ?? {}),
    currency: tokens?.currency ?? MODEL_PRICE_CATALOG_CURRENCY,
  };
}

export async function readPricedTokens(
  db: Db,
  where: SQL,
  thresholds: readonly number[],
): Promise<PricedTokens[]> {
  return (await readGroupedPricedTokens(db, where, thresholds, null)).map(
    ({ group, ...row }) => row,
  );
}

async function readGroupedPricedTokens(
  db: Db,
  where: SQL,
  thresholds: readonly number[],
  by: { column: SQL; from: SQL } | null,
): Promise<Array<PricedTokens & { group: string }>> {
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
        ${by ? by.column : sql`null`} as grp,
        count(*)::int as calls,
        coalesce(sum(llm_usage.prompt_tokens), 0)::float8 as prompt,
        coalesce(sum(llm_usage.completion_tokens), 0)::float8 as completion,
        coalesce(sum(llm_usage.cache_read_tokens), 0)::float8 as cache_read,
        coalesce(sum(llm_usage.cache_creation_tokens), 0)::float8 as cache_creation
      from ${by ? by.from : sql`llm_usage`}
      where ${where}
      group by 1, 2, 3
    `)
  ).rows as Record<string, unknown>[];
  return rows.map((row) => {
    const k = Number(row.tier ?? 0);
    return {
      group: row.grp == null ? "" : String(row.grp),
      model: row.model == null ? "" : String(row.model),
      calls: Number(row.calls ?? 0),
      prompt_tokens: Number(row.prompt ?? 0),
      completion_tokens: Number(row.completion ?? 0),
      cache_read_tokens: Number(row.cache_read ?? 0),
      cache_creation_tokens: Number(row.cache_creation ?? 0),
      prompt_tokens_exceed: k > 0 ? (thresholds[k - 1] ?? -1) : -1,
    };
  });
}

export async function readLlmCost(db: Db, tenantId: string, where: SQL): Promise<CostResult> {
  const { prices, currency } = tenantRates(tenantId);
  const rows = await readPricedTokens(db, where, longContextThresholds(prices));
  return priceCalls(rows, prices, currency);
}

export function readLlmWindowCost(
  db: Db,
  params: Omit<LlmStatsParams, "groupBy">,
): Promise<CostResult> {
  return readLlmCost(db, params.tenantId, buildWhere(params));
}

export async function readLlmCostByGroup(
  db: Db,
  params: Omit<LlmStatsParams, "groupBy">,
  dim: LlmGroupDim,
): Promise<Map<string, CostResult>> {
  const { prices, currency } = tenantRates(params.tenantId);
  const rows = await readGroupedPricedTokens(
    db,
    buildWhere(params),
    longContextThresholds(prices),
    { column: dimColumn(dim), from: llmFromClause([dim]) },
  );
  const byGroup = new Map<string, PricedTokens[]>();
  for (const { group, ...row } of rows) {
    const list = byGroup.get(group) ?? [];
    list.push(row);
    byGroup.set(group, list);
  }
  return new Map(
    [...byGroup].map(([group, calls]) => [group, priceCalls(calls, prices, currency)]),
  );
}
