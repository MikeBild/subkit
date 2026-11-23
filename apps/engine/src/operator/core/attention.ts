import type { RepairRemedy } from "@shared/error-taxonomy.ts";
import type { PreviewClassification } from "../../execution/classify.ts";
import type { BoundaryGrowth } from "../../workflows/authority-growth.ts";
import type { HealthState } from "../operational-overview.ts";

export const ATTENTION_SCHEMA_VERSION = "attention.v1" as const;

export const ATTENTION_SOURCES = [
  "conversations",
  "schedules",
  "freshness",
  "failures",
  "patches",
  "connectors",
  "connections",
  "secret_approvals",
  "skills",
  "intake",
  "budget",
  "ai_access",
  "risk",
  "tasks",
] as const;
export type AttentionSource = (typeof ATTENTION_SOURCES)[number];
export type AttentionSourceState = "answered" | "failed" | "not_permitted";

export type AttentionClass = "stopped" | "failing" | "decide";
export type AttentionSeverity = "critical" | "urgent" | "notice";
export type AttentionVerb =
  | "review"
  | "answer"
  | "reauth"
  | "renew"
  | "open_runs"
  | "chat"
  | "open";

export const ATTENTION_REASONS = [
  "awaiting_answer",
  "execution_authority_required",
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
  "version_awaiting_approval",
  "version_needs_repair",
  "approval_expiring",
  "schedule_auto_paused",
  "scheduler_stale",
  "failing",
  "patch_proposed",
  "needs_reauth",
  "needs_update",
  "degraded",
  "unhealthy",
  "refresh_refused",
  "refresh_failed",
  "expired_no_refresh",
  "secret_unreadable",
  "secret_prepared",
  "skills_proposed",
  "intake_collected",
  "spend_warning",
  "spend_limit_reached",
  "spend_limit_unset",
  "ai_access_missing",
  "model_tools_missing",
  "risk_critical",
  "task_run_failed",
  "task_result_ready",
  "task_grant_required",
  "task_grant_expiring",
  "task_owner_unavailable",
  "pair_approval_requested",
  "device_offline_waiting",
  "local_confirmation_needed",
  "device_permission_missing",
  "folder_changed",
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const ATTENTION_SUBJECT_KINDS = [
  "workflow",
  "conversation",
  "connector",
  "connection",
  "secret",
  "settings",
  "task",
  "device",
] as const;

export const APPROVAL_NEEDED_REASONS: ReadonlySet<AttentionReason> = new Set([
  "version_awaiting_approval",
  "execution_authority_required",
  "approval_expiring",
  "task_grant_required",
  "task_grant_expiring",
]);

export function needsApproval(item: { readonly reason: string }): boolean {
  return (APPROVAL_NEEDED_REASONS as ReadonlySet<string>).has(item.reason);
}

export interface AttentionAction {
  verb: AttentionVerb;
  href: string;
  primary: boolean;
  permission: string;
}

export interface IntakeCategoryCount {
  category: string;
  count: number;
}

export interface AttentionItem {
  id: string;
  class: AttentionClass;
  severity: AttentionSeverity;
  kind: string;
  subject: {
    kind: (typeof ATTENTION_SUBJECT_KINDS)[number];
    id: string;
    name: string | null;
    environment?: "dev" | "prod";
  } | null;
  reason: AttentionReason;
  trigger: { kind: "schedule" | "inbound_hook"; name: string | null } | null;
  approval?: {
    version: number;
    environment: "dev" | "prod";
    growth?: BoundaryGrowth[];
  };
  repair?: {
    step_id: string | null;
    code: string | null;
    remedy_kind: RepairRemedy;
    steps: number;
    candidate_id: string | null;
    execution_id: string | null;
  };
  cause_class: PreviewClassification | null;
  counts: {
    patches?: number;
    failures?: number;
    consecutive_failures?: number;
    skills?: number;
    intake?: number;
    intake_by_category?: IntakeCategoryCount[];
    intake_categories_omitted?: number;
  };
  since: string | null;
  deadline: string | null;
  detail: string | null;
  waiting_on?: { user_id: string; name: string };
  actions: AttentionAction[];
}

export interface AttentionV1 {
  schema_version: typeof ATTENTION_SCHEMA_VERSION;
  generated_at: string;
  sources: Record<AttentionSource, AttentionSourceState>;
  status: { health_state: HealthState; next_run_at: string | null } | null;
  items: AttentionItem[];
}

export function attentionAllClear(attention: AttentionV1): boolean {
  return (
    attention.items.length === 0 &&
    Object.values(attention.sources).every((state) => state !== "failed")
  );
}

const CLASS_RANK: Record<AttentionClass, number> = { stopped: 0, failing: 1, decide: 2 };

function compareNullableDate(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  const byClass = CLASS_RANK[a.class] - CLASS_RANK[b.class];
  if (byClass !== 0) return byClass;
  const byDeadline = compareNullableDate(a.deadline, b.deadline);
  if (byDeadline !== 0) return byDeadline;
  const bySince = compareNullableDate(a.since, b.since);
  if (bySince !== 0) return bySince;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function projectAttentionItems(
  items: readonly AttentionItem[],
  mayReadHookNames: boolean,
): AttentionItem[] {
  return items
    .map((item) =>
      !mayReadHookNames && item.trigger?.kind === "inbound_hook"
        ? { ...item, trigger: { ...item.trigger, name: null } }
        : item,
    )
    .sort(compareAttentionItems);
}
