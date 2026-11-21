import { and, eq, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { llmUsage } from "../db/schema/index.ts";
import type { CostResult } from "../llm/index.ts";
import { readLlmCost } from "../stats/index.ts";

export interface ConversationUsage {
  tokens: number;
  by_model: Array<{ model: string; tokens: number }>;
  cost: { amount: number; currency: string; unpriced_models: string[] } | null;
}

interface ConversationUsageRow {
  model: string;
  calls: number;
  total_tokens: number;
}

export function conversationUsageFrom(
  rows: readonly ConversationUsageRow[],
  priced: CostResult,
): ConversationUsage {
  const byModel = rows
    .map((row) => ({ model: row.model, tokens: row.total_tokens }))
    .sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1));
  const tokens = byModel.reduce((sum, row) => sum + row.tokens, 0);
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  if (calls === 0 || priced.unpriced_calls >= calls)
    return { tokens, by_model: byModel, cost: null };
  return {
    tokens,
    by_model: byModel,
    cost: {
      amount: priced.amount,
      currency: priced.currency,
      unpriced_models: priced.unpriced_models,
    },
  };
}

export async function readConversationUsage(
  db: Db,
  tenantId: string,
  conversationId: string,
  price: (db: Db, tenantId: string, where: SQL) => Promise<CostResult> = readLlmCost,
): Promise<ConversationUsage> {
  const tenantScoped = and(
    eq(llmUsage.tenant_id, tenantId),
    eq(llmUsage.conversation_id, conversationId),
  );
  if (!tenantScoped) throw new Error("conversation usage predicate is empty");
  const [rows, priced] = await Promise.all([
    db
      .select({
        model: llmUsage.model,
        calls: sql<number>`count(*)::int`,
        total_tokens: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::float8`,
      })
      .from(llmUsage)
      .where(tenantScoped)
      .groupBy(llmUsage.model),
    price(db, tenantId, tenantScoped),
  ]);
  return conversationUsageFrom(
    rows.map((row) => ({
      model: row.model,
      calls: Number(row.calls),
      total_tokens: Math.round(Number(row.total_tokens)),
    })),
    priced,
  );
}
