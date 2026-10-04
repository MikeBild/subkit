import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type NotificationRuleRow, notificationRules } from "../db/schema/notifications.ts";
import type { RequestSource } from "../execution/types.ts";

export type NotificationSeverity = "debug" | "info" | "warn" | "error" | "critical";
export type NotificationRequestSource = RequestSource;

export interface NotificationEvent {
  tenant_id: string;
  type: string;
  payload?: Record<string, unknown> | null;
  workflow_id?: string | null;
  workflow_slug?: string | null;
  severity?: NotificationSeverity;
  request_source?: NotificationRequestSource | null;
}

const SEVERITY_ORDER: Record<NotificationSeverity, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

export function matchGlob(pattern: string, value: string | null | undefined): boolean {
  if (!pattern) return false;
  if (value == null) {
    return pattern
      .split(",")
      .map((p) => p.trim())
      .some((p) => p === "*");
  }
  const parts = pattern
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const p of parts) {
    if (p === "*" || p === value) return true;
    if (p.endsWith(".*") && value.startsWith(p.slice(0, -1))) return true;
    if (p.endsWith("*") && !p.endsWith(".*") && value.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

export function severityMeets(
  event: NotificationSeverity | undefined,
  floor: NotificationSeverity,
): boolean {
  const e = SEVERITY_ORDER[event ?? "info"];
  const f = SEVERITY_ORDER[floor];
  return e >= f;
}

function normalizeSeverity(s: string | null | undefined): NotificationSeverity {
  if (s === "debug" || s === "info" || s === "warn" || s === "error" || s === "critical") {
    return s;
  }
  return "info";
}

function normalizeSourceFilter(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const arr = raw.filter((x): x is string => typeof x === "string");
    return arr.length === 0 ? null : arr;
  }
  return null;
}

export interface MatchedRule {
  row: NotificationRuleRow;
  severity: NotificationSeverity;
}

export async function matchRules(
  db: Db,
  tenant_id: string,
  event: NotificationEvent,
): Promise<MatchedRule[]> {
  const rows = await db
    .select()
    .from(notificationRules)
    .where(and(eq(notificationRules.tenant_id, tenant_id), eq(notificationRules.active, true)));

  const matched: MatchedRule[] = [];
  const workflowKey = event.workflow_id ?? event.workflow_slug ?? null;

  for (const row of rows) {
    if (!matchGlob(row.event_pattern, event.type)) continue;

    const workflowPattern = row.workflow_pattern ?? "*";
    if (workflowPattern !== "*" && !matchGlob(workflowPattern, workflowKey)) continue;

    const severityFloor = normalizeSeverity(row.severity);
    if (!severityMeets(event.severity, severityFloor)) continue;

    const filter = normalizeSourceFilter(row.request_source_filter);
    if (filter) {
      if (!event.request_source) continue;
      if (!filter.includes(event.request_source)) continue;
    }

    matched.push({ row, severity: severityFloor });
  }

  matched.sort((a, b) => {
    const at = a.row.created_at?.getTime?.() ?? 0;
    const bt = b.row.created_at?.getTime?.() ?? 0;
    return at - bt;
  });

  return matched;
}
