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
  "knowledge",
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
  "input_required",
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
  "device_handover_waiting",
  "knowledge_review_due",
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
  "knowledge",
] as const;

export const APPROVAL_NEEDED_REASONS: ReadonlySet<AttentionReason> = new Set([
  "version_awaiting_approval",
  "execution_authority_required",
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
  "approval_expiring",
  "task_grant_required",
  "task_grant_expiring",
]);

export function needsApproval(item: { readonly reason: string }): boolean {
  return (APPROVAL_NEEDED_REASONS as ReadonlySet<string>).has(item.reason);
}

const HELD_ATTENTION_REASONS: ReadonlySet<string> = new Set<AttentionReason>([
  "execution_authority_required",
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
  "input_required",
]);

export function heldAttentionReason(reason_code: string | null | undefined): AttentionReason {
  return reason_code && HELD_ATTENTION_REASONS.has(reason_code)
    ? (reason_code as AttentionReason)
    : "execution_authority_required";
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
    knowledge_reviews?: number;
  };
  since: string | null;
  deadline: string | null;
  detail: string | null;
  waiting_on?: { user_id: string; name: string };
  actions: AttentionAction[];
}

export interface SnoozedAttentionItem extends AttentionItem {
  attention_key: string;
  snoozed_until: string;
}

export interface AttentionV1 {
  schema_version: typeof ATTENTION_SCHEMA_VERSION;
  generated_at: string;
  sources: Record<AttentionSource, AttentionSourceState>;
  status: { health_state: HealthState; next_run_at: string | null } | null;
  items: AttentionItem[];
  snoozed: SnoozedAttentionItem[];
}

export const SNOOZE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const ATTENTION_KEY_MAX = 300;

export interface AttentionSnooze {
  readonly attention_key: string;
  readonly snoozed_until: Date;
}

export function attentionSnoozeKey(item: Pick<AttentionItem, "id" | "class" | "reason">): string {
  return `${item.id}|${item.class}|${item.reason}`;
}

export type SnoozePlan =
  | { readonly ok: true; readonly until: Date }
  | { readonly ok: false; readonly reason: "snooze_in_past" | "snooze_too_long" };

export function planSnooze(until: Date, at: Date): SnoozePlan {
  if (!(until.getTime() > at.getTime())) return { ok: false, reason: "snooze_in_past" };
  if (until.getTime() - at.getTime() > SNOOZE_MAX_MS)
    return { ok: false, reason: "snooze_too_long" };
  return { ok: true, until };
}

export function splitSnoozed(
  items: readonly AttentionItem[],
  snoozes: readonly AttentionSnooze[],
  at: Date,
): { items: AttentionItem[]; snoozed: SnoozedAttentionItem[] } {
  const active = new Map<string, Date>();
  for (const snooze of snoozes)
    if (snooze.snoozed_until.getTime() > at.getTime())
      active.set(snooze.attention_key, snooze.snoozed_until);
  const kept: AttentionItem[] = [];
  const snoozed: SnoozedAttentionItem[] = [];
  for (const item of items) {
    const attention_key = attentionSnoozeKey(item);
    const until = active.get(attention_key);
    if (until) snoozed.push({ ...item, attention_key, snoozed_until: until.toISOString() });
    else kept.push(item);
  }
  return { items: kept, snoozed };
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
