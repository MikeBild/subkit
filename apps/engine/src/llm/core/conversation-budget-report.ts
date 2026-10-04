import { TtlCache } from "../../utils/ttl-cache.ts";

export interface ConversationBudgetReport {
  cap_tokens: number;
  total_tokens: number;
  dropped_sections: string[];
  assembled_at: string;
}

const cache = new TtlCache<ConversationBudgetReport>({
  maxEntries: 500,
  ttlMs: 6 * 60 * 60 * 1000,
});

const key = (tenant_id: string, conversation_id: string): string =>
  `${tenant_id}:${conversation_id}`;

function compressDroppedSections(sections: string[]): string[] {
  const counts = new Map<string, number>();
  for (const s of sections) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
}

export function recordConversationBudgetReport(
  tenant_id: string,
  conversation_id: string,
  report: ConversationBudgetReport,
): void {
  cache.set(key(tenant_id, conversation_id), {
    ...report,
    dropped_sections: compressDroppedSections(report.dropped_sections),
  });
}

export function getConversationBudgetReport(
  tenant_id: string,
  conversation_id: string,
): ConversationBudgetReport | null {
  return cache.get(key(tenant_id, conversation_id)) ?? null;
}
