// What one conversation has cost so far, read off the LLM ledger.
//
// The chat header shows the conversation's own tokens and, where the models
// are priced, its money. Both come from `llm_usage` — the same ledger the
// budget and the usage page read — over the rows the turn loop tags with this
// conversation (`llm_usage_conversation_idx`). Nothing is stored beside it: a
// second counter would be a second number that drifts.
//
// Priced through `readLlmCost`, the one pricing path every surface uses (it
// prices from the rows, so a long-context call is charged its own tier), so
// the header can never price a model the usage page calls unpriced. A cost
// that covers no call at all is `null`, not zero: "no model here has a rate"
// is a different fact from "this conversation was free".

import { and, eq, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { llmUsage } from "../db/schema/index.ts";
import type { CostResult } from "../llm/index.ts";
import { readLlmCost } from "../stats/llm-cost.ts";

export interface ConversationUsage {
  /** Ledger tokens (`total_tokens`, the budget's own weighting) over every call. */
  tokens: number;
  by_model: Array<{ model: string; tokens: number }>;
  /** `null` when no call of this conversation had a rate. */
  cost: { amount: number; currency: string; unpriced_models: string[] } | null;
}

/** One ledger rollup row: a model's calls and ledger tokens over the conversation. */
export interface ConversationUsageRow {
  model: string;
  calls: number;
  total_tokens: number;
}

/** Shape the rollup and its price into the answer; pure, so the rule is testable. */
export function conversationUsageFrom(
  rows: readonly ConversationUsageRow[],
  priced: CostResult,
): ConversationUsage {
  const byModel = rows
    .map((row) => ({ model: row.model, tokens: row.total_tokens }))
    .sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1));
  const tokens = byModel.reduce((sum, row) => sum + row.tokens, 0);
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  // No call, or every call unpriced: there is no amount, only its absence.
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

/**
 * The conversation's usage. Tenant first: a conversation id alone must never
 * reach another tenant's ledger rows.
 */
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
