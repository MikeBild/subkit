import { type SQL, sql } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { type BucketUnit, WINDOW_CAP_MS } from "../http/routes/stats/bucket-window.ts";
import {
  type CostResult,
  effectiveModelPrices,
  findModelPrice,
  longContextThresholds,
  MODEL_PRICE_CATALOG_CURRENCY,
  type PricedTokens,
  type PriceSource,
  priceCalls,
  type SourcedModelPrice,
} from "../llm/index.ts";
import {
  buildWhere,
  dimColumn,
  type LlmGroupDim,
  type LlmStatsParams,
  llmBucketExpr,
  llmBucketKey,
  llmFromClause,
  llmGroupKey,
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
  from: SQL = sql`llm_usage`,
): Promise<PricedTokens[]> {
  return (await readKeyedPricedTokens(db, where, thresholds, from, [], null)).map(
    ({ key: _key, ts: _ts, ...row }) => row,
  );
}

async function readKeyedPricedTokens(
  db: Db,
  where: SQL,
  thresholds: readonly number[],
  from: SQL,
  dims: readonly LlmGroupDim[],
  bucket: SQL | null,
): Promise<Array<PricedTokens & { key: Record<string, string>; ts: string | null }>> {
  const tier =
    thresholds.length === 0
      ? sql`0`
      : sql.join(
          thresholds.map(
            (t) => sql`(case when coalesce(llm_usage.prompt_tokens, 0) > ${t} then 1 else 0 end)`,
          ),
          sql` + `,
        );
  const dimSelects = dims.map((d) => sql`, ${dimColumn(d)} as ${sql.raw(`dim_${d}`)}`);
  const groupCols = [sql`1`, sql`2`, sql`3`, ...dims.map((_, index) => sql.raw(String(index + 4)))];
  const rows = (
    await db.execute(sql`
      select
        llm_usage.model as model,
        (${tier})::int as tier,
        ${bucket ?? sql`null`} as bucket_ts
        ${sql.join(dimSelects, sql``)},
        count(*)::int as calls,
        coalesce(sum(llm_usage.prompt_tokens), 0)::float8 as prompt,
        coalesce(sum(llm_usage.completion_tokens), 0)::float8 as completion,
        coalesce(sum(llm_usage.cache_read_tokens), 0)::float8 as cache_read,
        coalesce(sum(llm_usage.cache_creation_tokens), 0)::float8 as cache_creation
      from ${from}
      where ${where}
      group by ${sql.join(groupCols, sql`, `)}
    `)
  ).rows as Record<string, unknown>[];
  return rows.map((row) => {
    const k = Number(row.tier ?? 0);
    const key: Record<string, string> = {};
    for (const d of dims) {
      const v = row[`dim_${d}`];
      key[d] = v == null ? "" : String(v);
    }
    return {
      key,
      ts: row.bucket_ts == null ? null : new Date(row.bucket_ts as string).toISOString(),
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

export async function readLlmCost(
  db: Db,
  tenantId: string,
  where: SQL,
  from: SQL = sql`llm_usage`,
): Promise<CostResult> {
  const { prices, currency } = tenantRates(tenantId);
  const rows = await readPricedTokens(db, where, longContextThresholds(prices), from);
  return priceCalls(rows, prices, currency);
}

export function readLlmWindowCost(
  db: Db,
  params: Omit<LlmStatsParams, "groupBy">,
): Promise<CostResult> {
  return readLlmCost(db, params.tenantId, buildWhere(params), llmFromClause(params));
}

interface KeyedLlmCost {
  groups: Map<string, CostResult>;
  buckets: Map<string, CostResult>;
}

export async function readLlmCostByKey(
  db: Db,
  params: Omit<LlmStatsParams, "groupBy">,
  dims: readonly LlmGroupDim[],
): Promise<KeyedLlmCost> {
  const { prices, currency } = tenantRates(params.tenantId);
  const filter = { ...params, groupBy: [...dims] };
  const rows = await readKeyedPricedTokens(
    db,
    buildWhere(filter),
    longContextThresholds(prices),
    llmFromClause(filter),
    dims,
    llmBucketExpr(params),
  );
  const byGroup = new Map<string, PricedTokens[]>();
  const byBucket = new Map<string, PricedTokens[]>();
  const add = (into: Map<string, PricedTokens[]>, key: string, row: PricedTokens) => {
    const list = into.get(key) ?? [];
    list.push(row);
    into.set(key, list);
  };
  for (const { key, ts, ...row } of rows) {
    const groupKey = llmGroupKey(dims, key);
    add(byGroup, groupKey, row);
    if (ts) add(byBucket, llmBucketKey(groupKey, ts), row);
  }
  const price = (from: Map<string, PricedTokens[]>) =>
    new Map([...from].map(([key, calls]) => [key, priceCalls(calls, prices, currency)]));
  return { groups: price(byGroup), buckets: price(byBucket) };
}

interface EffectiveModelRate {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  price_source: PriceSource;
  currency: string;
}

export function effectiveModelRate(tenantId: string, model: string): EffectiveModelRate | null {
  const { prices, currency } = tenantRates(tenantId);
  const found = findModelPrice(model, prices);
  if (!found) return null;
  return {
    input_per_mtok: found.rate.input_per_mtok,
    output_per_mtok: found.rate.output_per_mtok,
    cache_read_per_mtok: found.rate.cache_read_per_mtok,
    cache_write_per_mtok: found.rate.cache_write_per_mtok,
    price_source: found.source,
    currency,
  };
}
