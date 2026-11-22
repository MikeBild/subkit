import { and, desc, eq, gte, max } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { llmUsage, runtimeSecretVersions } from "../db/schema/index.ts";
import { classifyProviderError } from "../llm/provider-errors.ts";
import { llmKeySecretName } from "../runtime-config/index.ts";

const PROVIDER_OUTAGE_WINDOW_MS = 60 * 60_000;
const PROVIDER_OUTAGE_MIN_FAILURES = 2;
const PROVIDER_OUTAGE_SCAN_LIMIT = 50;

export type ProviderOutageKind =
  | "llm_key_rejected"
  | "llm_provider_quota"
  | "llm_provider_unavailable";

export interface ProviderOutage {
  kind: ProviderOutageKind;
  failures: number;
  since: string;
  last_error: string | null;
}

interface UsageOutcome {
  result: string;
  error: string | null;
  created_at: Date;
}

export function providerOutageFrom(
  rows: readonly UsageOutcome[],
  key_changed_at: Date | null = null,
): ProviderOutage | null {
  const streak: UsageOutcome[] = [];
  for (const row of rows) {
    if (row.result === "success") break;
    if (row.result === "key_rejected" && key_changed_at !== null && row.created_at < key_changed_at)
      break;
    if (row.result === "error" || row.result === "key_rejected") streak.push(row);
  }
  const latest = streak[0];
  const earliest = streak[streak.length - 1];
  if (!latest || !earliest) return null;
  const rejected = streak.filter((row) => row.result === "key_rejected");
  const firstRejected = rejected[rejected.length - 1];
  if (latest.result === "key_rejected" && firstRejected)
    return {
      kind: "llm_key_rejected",
      failures: rejected.length,
      since: firstRejected.created_at.toISOString(),
      last_error: latest.error,
    };
  if (streak.length < PROVIDER_OUTAGE_MIN_FAILURES) return null;
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
  const [key] = await db
    .select({ changed_at: max(runtimeSecretVersions.created_at) })
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, llmKeySecretName(tenantId)));
  return providerOutageFrom(rows, key?.changed_at ?? null);
}
