// Last per-conversation context BudgetReport — in-process transparency
// cache for the `/context` snapshot, NOT accounting (usage metering lives
// in llm/accounting). Before this, trimming was observable only in logs
// and metrics: an operator asking "why doesn't the agent remember the
// connector schema?" had no in-band answer. The snapshot route reads the
// last report so `/context` can show what the previous turn dropped.
//
// In-process on purpose (no migration, no hot-path write amplification;
// the engine is a single process): after a restart the field is simply
// absent until the next turn assembles — honest, not stale.

import { TtlCache } from "../../utils/ttl-cache.ts";

export interface ConversationBudgetReport {
  cap_tokens: number;
  total_tokens: number;
  dropped_sections: string[];
  /** ISO-8601 time the report was recorded (assembly time). */
  assembled_at: string;
}

const cache = new TtlCache<ConversationBudgetReport>({
  maxEntries: 500,
  ttlMs: 6 * 60 * 60 * 1000,
});

const key = (tenant_id: string, conversation_id: string): string =>
  `${tenant_id}:${conversation_id}`;

export function recordConversationBudgetReport(
  tenant_id: string,
  conversation_id: string,
  report: ConversationBudgetReport,
): void {
  cache.set(key(tenant_id, conversation_id), report);
}

export function getConversationBudgetReport(
  tenant_id: string,
  conversation_id: string,
): ConversationBudgetReport | null {
  return cache.get(key(tenant_id, conversation_id)) ?? null;
}
