import type { components } from "@cli-core/engine-api/openapi";
import { type Locale, t } from "./i18n.ts";

type ApiAttentionItem = components["schemas"]["AttentionItem"];
type ApiAttentionAction = components["schemas"]["AttentionAction"];

export type AttentionClass = ApiAttentionItem["class"];
export type AttentionSeverity = ApiAttentionItem["severity"];

export type AttentionAction = Pick<ApiAttentionAction, "href" | "primary"> & { verb: string };

export type AttentionItem = Pick<ApiAttentionItem, "id" | "class" | "severity" | "kind"> & {
  subjectName: string | null;
  reason: string;
  since?: string | null;
  actions: AttentionAction[];
};

const CLASSES = new Set<string>(["stopped", "failing", "decide"] satisfies AttentionClass[]);
const SEVERITIES = new Set<string>(["critical", "urgent", "notice"] satisfies AttentionSeverity[]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseItem(raw: unknown): AttentionItem | null {
  const item = record(raw);
  if (!item || typeof item.id !== "string" || !item.id || item.id.length > 256) return null;
  const actions: AttentionAction[] = [];
  for (const entry of Array.isArray(item.actions) ? item.actions : []) {
    const action = record(entry);
    if (!action || typeof action.verb !== "string" || typeof action.href !== "string") continue;
    actions.push({ verb: action.verb, href: action.href, primary: action.primary === true });
  }
  const name = record(item.subject)?.name;
  return {
    id: item.id,
    class: CLASSES.has(String(item.class)) ? (item.class as AttentionClass) : "decide",
    severity: SEVERITIES.has(String(item.severity))
      ? (item.severity as AttentionSeverity)
      : "notice",
    kind: typeof item.kind === "string" ? item.kind : "",
    subjectName: typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : null,
    reason: typeof item.reason === "string" ? item.reason : "",
    since: typeof item.since === "string" ? item.since : null,
    actions,
  };
}

export function parseAttention(json: unknown): AttentionItem[] | null {
  const root = record(json);
  if (!root || !Array.isArray(root.items)) return null;
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  for (const raw of root.items) {
    const item = parseItem(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

export function primaryAction(item: AttentionItem): AttentionAction | null {
  return item.actions.find((action) => action.primary) ?? item.actions[0] ?? null;
}

export interface NativeNotification {
  id: string;
  title: string;
  body: string;
  href: string | null;
  urgency: "critical" | "normal" | "low";
  silent: boolean;
  onDevice?: "permissions";
}

export const PERMISSION_REASON = "device_permission_missing";

const VERB_KEYS = {
  review: "notify.do.review",
  answer: "notify.do.answer",
  reauth: "notify.do.reauth",
  renew: "notify.do.renew",
  open_runs: "notify.do.open_runs",
  chat: "notify.do.chat",
  open: "notify.do.open",
} as const;

const REASON_KEYS = {
  awaiting_answer: "notify.reason.awaiting_answer",
  execution_authority_required: "notify.reason.execution_authority_required",
  execution_authority_unavailable: "notify.reason.execution_authority_unavailable",
  version_awaiting_approval: "notify.reason.version_awaiting_approval",
  pair_approval_requested: "notify.reason.pair_approval_requested",
  version_needs_repair: "notify.reason.version_needs_repair",
  approval_expiring: "notify.reason.approval_expiring",
  schedule_auto_paused: "notify.reason.schedule_auto_paused",
  scheduler_stale: "notify.reason.scheduler_stale",
  failing: "notify.reason.failing",
  patch_proposed: "notify.reason.patch_proposed",
  needs_reauth: "notify.reason.needs_reauth",
  needs_update: "notify.reason.needs_update",
  degraded: "notify.reason.degraded",
  unhealthy: "notify.reason.unhealthy",
  refresh_refused: "notify.reason.refresh_refused",
  refresh_failed: "notify.reason.refresh_failed",
  expired_no_refresh: "notify.reason.expired_no_refresh",
  secret_unreadable: "notify.reason.secret_unreadable",
  secret_prepared: "notify.reason.secret_prepared",
  skills_proposed: "notify.reason.skills_proposed",
  intake_collected: "notify.reason.intake_collected",
  spend_warning: "notify.reason.spend_warning",
  spend_limit_reached: "notify.reason.spend_limit_reached",
  spend_limit_unset: "notify.reason.spend_limit_unset",
  ai_access_missing: "notify.reason.ai_access_missing",
  model_tools_missing: "notify.reason.model_tools_missing",
  risk_critical: "notify.reason.risk_critical",
  task_run_failed: "notify.reason.task_run_failed",
  task_result_ready: "notify.reason.task_result_ready",
  task_grant_required: "notify.reason.task_grant_required",
  task_grant_expiring: "notify.reason.task_grant_expiring",
  task_owner_unavailable: "notify.reason.task_owner_unavailable",
  device_offline_waiting: "notify.reason.device_offline_waiting",
  local_confirmation_needed: "notify.reason.local_confirmation_needed",
  device_permission_missing: "notify.reason.device_permission_missing",
  folder_changed: "notify.reason.folder_changed",
} as const;

export const NOTIFICATION_REASONS: readonly string[] = Object.keys(REASON_KEYS);

export function reasonLine(reason: string, locale: Locale): string | null {
  return reason in REASON_KEYS ? t(locale, REASON_KEYS[reason as keyof typeof REASON_KEYS]) : null;
}

export const AUTO_PAUSE_REASON = "schedule_auto_paused";
export const PAUSED_SUMMARY_ID = "summary:schedules_paused";

export const DIGEST_SUMMARY_ID = "summary:attention";
const SUMMARY_CLASSES: readonly AttentionClass[] = ["stopped", "failing", "decide"];

function sinceOf(item: AttentionItem): number {
  const parsed = item.since ? Date.parse(item.since) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function newestItem(items: readonly AttentionItem[]): AttentionItem | null {
  let newest: AttentionItem | null = null;
  for (const item of items) if (newest === null || sinceOf(item) > sinceOf(newest)) newest = item;
  return newest;
}

export function summaryNotification(
  items: readonly AttentionItem[],
  locale: Locale,
): NativeNotification {
  const parts = SUMMARY_CLASSES.flatMap((klass) => {
    const count = items.filter((item) => item.class === klass).length;
    if (count === 0) return [];
    const key =
      klass === "decide"
        ? count === 1
          ? "notify.summary.decide.one"
          : "notify.summary.decide.other"
        : klass === "failing"
          ? "notify.summary.failing"
          : "notify.summary.stopped";
    return [t(locale, key, { count })];
  });
  const newest = newestItem(items);
  const action = newest ? primaryAction(newest) : null;
  const critical = items.some((item) => item.severity === "critical");
  const quiet = items.every((item) => item.severity === "notice");
  return {
    id: DIGEST_SUMMARY_ID,
    title: t(locale, "notify.summary.title", { count: items.length }),
    body: parts.join(", "),
    href: action ? action.href : null,
    urgency: critical ? "critical" : quiet ? "low" : "normal",
    silent: quiet,
  };
}

export function toNotifications(
  items: readonly AttentionItem[],
  locale: Locale,
  summary = false,
): NativeNotification[] {
  if (summary && items.length >= DIGEST_SUMMARY_MIN_ITEMS)
    return [summaryNotification(items, locale)];
  const paused = items.filter((item) => item.reason === AUTO_PAUSE_REASON);
  if (paused.length < 2) return items.map((item) => toNotification(item, locale));
  const critical = paused.some((item) => item.severity === "critical");
  return [
    {
      id: PAUSED_SUMMARY_ID,
      title: t(locale, "notify.summary.schedulesPaused", { count: paused.length }),
      body: t(locale, "notify.summary.schedulesPaused.do"),
      href: null,
      urgency: critical ? "critical" : "normal",
      silent: false,
    },
    ...items
      .filter((item) => item.reason !== AUTO_PAUSE_REASON)
      .map((item) => toNotification(item, locale)),
  ];
}

export function toNotification(item: AttentionItem, locale: Locale): NativeNotification {
  const action = primaryAction(item);
  const name = item.subjectName;
  const title = name
    ? t(locale, `notify.title.${item.class}.named`, { name })
    : t(locale, `notify.title.${item.class}.plain`);
  const verbKey =
    action && action.verb in VERB_KEYS ? VERB_KEYS[action.verb as keyof typeof VERB_KEYS] : null;
  return {
    id: item.id,
    title,
    body: [reasonLine(item.reason, locale), t(locale, verbKey ?? "notify.do.open")]
      .filter((line) => line !== null)
      .join(" "),
    href: action ? action.href : null,
    urgency:
      item.severity === "critical" ? "critical" : item.severity === "urgent" ? "normal" : "low",
    silent: item.severity === "notice",
    ...(item.reason === PERMISSION_REASON ? { onDevice: "permissions" as const } : {}),
  };
}

export interface NotificationPlanInput {
  items: readonly AttentionItem[];
  notifiedIds: readonly string[];
  baselineDone: boolean;
  announce: boolean;
  hintId: string | null;
  muted: boolean;
  delivery?: "held" | "critical_only" | null;
  released?: boolean;
}

export interface NotificationPlan {
  notify: AttentionItem[];
  notifiedIds: string[];
  baselineDone: boolean;
  summary: boolean;
}

export const NOTIFICATION_BURST_LIMIT = 3;
export const DIGEST_SUMMARY_MIN_ITEMS = 2;

export function planNotifications(input: NotificationPlanInput): NotificationPlan {
  const open = new Set(input.items.map((item) => item.id));
  const kept = input.notifiedIds.filter((id) => open.has(id));
  if (!input.baselineDone) {
    return { notify: [], notifiedIds: [...open], baselineDone: true, summary: false };
  }
  if (!input.announce) return { notify: [], notifiedIds: kept, baselineDone: true, summary: false };
  const known = new Set(kept);
  const fresh = input.items.filter((item) => !known.has(item.id));
  const hinted = input.hintId ? fresh.filter((item) => item.id === input.hintId) : [];
  if (input.delivery === "held")
    return { notify: [], notifiedIds: kept, baselineDone: true, summary: false };
  const summary =
    input.released === true && !input.delivery && fresh.length >= DIGEST_SUMMARY_MIN_ITEMS;
  const candidates = summary || hinted.length === 0 ? fresh : hinted;
  const due =
    input.delivery === "critical_only"
      ? candidates.filter((item) => item.severity === "critical")
      : candidates;
  const notifiedIds = [...kept, ...due.map((item) => item.id)];
  return {
    notify: input.muted ? [] : summary ? due : due.slice(0, NOTIFICATION_BURST_LIMIT),
    notifiedIds,
    baselineDone: true,
    summary,
  };
}

export const HINT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000];

export function hintRetryDelay(attempt: number): number | null {
  return HINT_RETRY_DELAYS_MS[attempt] ?? null;
}

export function hintPending(items: readonly AttentionItem[], hintId: string | null): boolean {
  return hintId !== null && !items.some((item) => item.id === hintId);
}

export function badgeLabel(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}
