import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import { type Executor, getDb } from "../../db/client.ts";
import { llmUsage, tenants } from "../../db/schema/index.ts";
import { now } from "../../utils/clock.ts";
import {
  type ModelWork,
  type MonthWindow,
  roundUsd,
  type SpendStatus,
  spendAllows,
  spendCountable,
  spendCurrency,
  spendLimit,
  spendMonthWindow,
  spendStatus,
} from "../core/spend-budget.ts";
import { effectiveModelPrices, MODEL_PRICE_CATALOG_CURRENCY } from "../model-price-catalog.ts";
import { longContextThresholds, type PricedTokens, priceCalls } from "../pricing.ts";

export interface SpendReading extends SpendStatus {
  currency: string;
  countable: boolean;
  timezone: string;
  window: MonthWindow;
  unpriced_calls: number;
  chosen: boolean;
}

interface TenantPricing {
  currency: string;
  countable: boolean;
  prices: ReturnType<typeof effectiveModelPrices>;
}

function tenantPricing(tenant_id: string): TenantPricing | null {
  if (!isConfigLoaded()) return null;
  const tokens = getConfig(tenant_id).tokens;
  const currency = spendCurrency(tokens?.currency, MODEL_PRICE_CATALOG_CURRENCY);
  return {
    currency,
    countable: spendCountable(currency, MODEL_PRICE_CATALOG_CURRENCY),
    prices: effectiveModelPrices(tokens ?? {}),
  };
}

export interface SpendWorkspace {
  timezone: string;
  limit_usd: number;
  continue_month: string;
  chosen: boolean;
}

export async function spendWorkspace(db: Executor, tenant_id: string): Promise<SpendWorkspace> {
  const [row] = await db
    .select({
      timezone: tenants.timezone,
      limit: tenants.spend_limit_usd,
      continue_month: tenants.spend_continue_month,
      chosen_at: tenants.spend_limit_chosen_at,
    })
    .from(tenants)
    .where(eq(tenants.id, tenant_id))
    .limit(1);
  return {
    timezone: row?.timezone ?? "UTC",
    limit_usd: Number(row?.limit ?? 0),
    continue_month: row?.continue_month ?? "",
    chosen: row ? row.chosen_at !== null : true,
  };
}

export async function pricedUsdWhere(
  db: Executor,
  tenant_id: string,
  scope: SQL,
  prices = tenantPricing(tenant_id)?.prices ?? effectiveModelPrices({}),
): Promise<{ amount: number; unpriced_calls: number }> {
  const thresholds = longContextThresholds(prices);
  const tier =
    thresholds.length === 0
      ? sql<number>`0`
      : sql<number>`(${sql.join(
          thresholds.map(
            (t) => sql`(case when coalesce(${llmUsage.prompt_tokens}, 0) > ${t} then 1 else 0 end)`,
          ),
          sql` + `,
        )})`;
  const rows = await db
    .select({
      model: llmUsage.model,
      tier: sql<number>`${tier}::int`,
      calls: sql<number>`count(*)::int`,
      prompt: sql<number>`coalesce(sum(${llmUsage.prompt_tokens}), 0)::float8`,
      completion: sql<number>`coalesce(sum(${llmUsage.completion_tokens}), 0)::float8`,
      cache_read: sql<number>`coalesce(sum(${llmUsage.cache_read_tokens}), 0)::float8`,
      cache_creation: sql<number>`coalesce(sum(${llmUsage.cache_creation_tokens}), 0)::float8`,
    })
    .from(llmUsage)
    .where(and(eq(llmUsage.tenant_id, tenant_id), scope))
    .groupBy(sql`1`, sql`2`);
  const calls: PricedTokens[] = rows.map((row) => {
    const k = Number(row.tier ?? 0);
    return {
      model: row.model,
      calls: Number(row.calls ?? 0),
      prompt_tokens: Number(row.prompt ?? 0),
      completion_tokens: Number(row.completion ?? 0),
      cache_read_tokens: Number(row.cache_read ?? 0),
      cache_creation_tokens: Number(row.cache_creation ?? 0),
      prompt_tokens_exceed: k > 0 ? (thresholds[k - 1] ?? -1) : -1,
    };
  });
  const priced = priceCalls(calls, prices, MODEL_PRICE_CATALOG_CURRENCY);
  return { amount: roundUsd(priced.amount), unpriced_calls: priced.unpriced_calls };
}

export async function readSpend(
  tenant_id: string,
  exec?: Executor,
  at: Date = new Date(now()),
): Promise<SpendReading> {
  const db = exec ?? getDb();
  const pricing = tenantPricing(tenant_id);
  const workspace = await spendWorkspace(db, tenant_id);
  const window = spendMonthWindow(at, workspace.timezone);
  const countable = pricing?.countable === true;
  const limit = countable ? spendLimit(workspace.limit_usd) : null;
  const spent =
    countable && pricing
      ? await pricedUsdWhere(
          db,
          tenant_id,
          and(gte(llmUsage.created_at, window.from), lt(llmUsage.created_at, window.to)) ??
            sql`true`,
          pricing.prices,
        )
      : { amount: 0, unpriced_calls: 0 };
  return {
    ...spendStatus({
      limit_usd: limit,
      spent_usd: spent.amount,
      month: window.month,
      continue_month: workspace.continue_month,
    }),
    currency: pricing?.currency ?? MODEL_PRICE_CATALOG_CURRENCY,
    countable,
    timezone: workspace.timezone,
    window,
    unpriced_calls: spent.unpriced_calls,
    chosen: workspace.chosen,
  };
}

export type SpendVerdict = { ok: true } | { ok: false; reading: SpendReading };

export async function spendVerdict(
  tenant_id: string,
  work: ModelWork,
  exec?: Executor,
): Promise<SpendVerdict> {
  if (!isConfigLoaded()) return { ok: true };
  const reading = await readSpend(tenant_id, exec);
  return spendAllows(reading, work) ? { ok: true } : { ok: false, reading };
}

export function spendRefusalDetails(reading: SpendReading): Record<string, unknown> {
  return {
    scope: "spend",
    limit_usd: reading.limit_usd,
    spent_usd: reading.spent_usd,
    month: reading.month,
    currency: reading.currency,
  };
}

export async function conversationSpendUsd(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
): Promise<number | null> {
  const config = tenantPricing(tenant_id);
  if (!config?.countable) return null;
  const priced = await pricedUsdWhere(
    db,
    tenant_id,
    eq(llmUsage.conversation_id, conversation_id),
    config.prices,
  );
  return priced.amount;
}
