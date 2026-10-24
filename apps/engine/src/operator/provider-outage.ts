import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { llmUsage } from "../db/schema/index.ts";
import { classifyProviderError } from "../llm/provider-errors.ts";

export const PROVIDER_OUTAGE_WINDOW_MS = 60 * 60_000;
export const PROVIDER_OUTAGE_MIN_FAILURES = 2;
const PROVIDER_OUTAGE_SCAN_LIMIT = 50;

export type ProviderOutageKind = "llm_provider_quota" | "llm_provider_unavailable";

export interface ProviderOutage {
  kind: ProviderOutageKind;
  failures: number;
  since: string;
  last_error: string | null;
}

export interface UsageOutcome {
  result: string;
  error: string | null;
  created_at: Date;
}

export function providerOutageFrom(rows: readonly UsageOutcome[]): ProviderOutage | null {
  const streak: UsageOutcome[] = [];
  for (const row of rows) {
    if (row.result === "success") break;
    if (row.result === "error") streak.push(row);
  }
  const latest = streak[0];
  const earliest = streak[streak.length - 1];
  if (!latest || !earliest || streak.length < PROVIDER_OUTAGE_MIN_FAILURES) return null;
  const quota = streak.some(
    (row) => classifyProviderError(new Error(row.error ?? "")) === "quota_exhausted",
  );
  return {
    kind: quota ? "llm_provider_quota" : "llm_provider_unavailable",
    failures: streak.length,
    since: earliest.created_at.toISOString(),
    last_error: latest.error,
  };
}

export async function readProviderOutage(
  db: Db,
  tenantId: string,
  now: Date,
): Promise<ProviderOutage | null> {
  const rows = await db
    .select({ result: llmUsage.result, error: llmUsage.error, created_at: llmUsage.created_at })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.tenant_id, tenantId),
        gte(llmUsage.created_at, new Date(now.getTime() - PROVIDER_OUTAGE_WINDOW_MS)),
      ),
    )
    .orderBy(desc(llmUsage.created_at))
    .limit(PROVIDER_OUTAGE_SCAN_LIMIT);
  return providerOutageFrom(rows);
}
