import type { components } from "@cli-core/engine-api/openapi";
import { reviewFromUrl, workflowAutomationHref, workflowHref } from "@/app/links";
import { growthLine } from "@/features/grants/model";
import { cardLabel, formatMinor } from "@/features/vault";
import { autoPauseRemedy } from "@/features/workflows/model";
import { causeClassKey } from "@/lib/cause-class";
import { type EngineSentence, engineSentence } from "@/lib/engine-sentence";
import type { Locale, Translate } from "@/lib/i18n";
import { CATALOGS, type PluralKey, pluralKey, type TranslationKey } from "@/lib/i18n";
import { clipAtWord } from "@/lib/presentation";
import {
  opensReviewSheet as navigationOpensReviewSheet,
  reviewForward as navigationReviewForward,
  type ReviewAccess,
} from "./attention-navigation";
import {
  type Attention,
  type AttentionItem,
  type AttentionSource,
  entryActions as projectedEntryActions,
} from "./attention-projection";

export type AttentionAction = components["schemas"]["AttentionAction"];
export type HealthState = NonNullable<Attention["status"]>["health_state"];

const VAULT_REASON_KEYS = {
  payment_approval_needed: "overview.reason.payment_approval_needed",
  sign_in_confirmation_needed: "overview.reason.sign_in_confirmation_needed",
} as const;

const REASON_KEYS = {
  ...VAULT_REASON_KEYS,
  awaiting_answer: "overview.reason.awaiting_answer",
  execution_authority_required: "overview.reason.execution_authority_required",
  execution_authority_expired: "overview.reason.execution_authority_expired",
  execution_authority_exhausted: "overview.reason.execution_authority_exhausted",
  execution_authority_revoked: "overview.reason.execution_authority_revoked",
  execution_authority_changed: "overview.reason.execution_authority_changed",
  input_required: "overview.reason.input_required",
  version_awaiting_approval: "overview.reason.version_awaiting_approval",
  version_needs_repair: "overview.reason.version_needs_repair",
  approval_expiring: "overview.reason.approval_expiring",
  schedule_auto_paused: "overview.reason.schedule_auto_paused",
  scheduler_stale: "overview.reason.scheduler_stale",
  failing: "overview.reason.failing",
  patch_proposed: "overview.reason.patch_proposed",
  needs_reauth: "overview.reason.needs_reauth",
  needs_update: "overview.reason.needs_update",
  degraded: "overview.reason.degraded",
  unhealthy: "overview.reason.unhealthy",
  refresh_refused: "overview.reason.refresh_refused",
  refresh_failed: "overview.reason.refresh_failed",
  expired_no_refresh: "overview.reason.expired_no_refresh",
  secret_unreadable: "overview.reason.secret_unreadable",
  secret_prepared: "overview.reason.secret_prepared",
  skills_proposed: "overview.reason.skills_proposed",
  intake_collected: "overview.reason.intake_collected",
  spend_warning: "overview.reason.spend_warning",
  spend_limit_reached: "overview.reason.spend_limit_reached",
  spend_limit_unset: "overview.reason.spend_limit_unset",
  ai_access_missing: "overview.reason.ai_access_missing",
  model_tools_missing: "overview.reason.model_tools_missing",
  risk_critical: "overview.reason.risk_critical",
  task_run_failed: "overview.reason.task_run_failed",
  task_result_ready: "overview.reason.task_result_ready",
  task_grant_required: "overview.reason.task_grant_required",
  task_grant_expiring: "overview.reason.task_grant_expiring",
  task_owner_unavailable: "overview.reason.task_owner_unavailable",
  pair_approval_requested: "overview.reason.pair_approval_requested",
  device_offline_waiting: "overview.reason.device_offline_waiting",
  local_confirmation_needed: "overview.reason.local_confirmation_needed",
  device_permission_missing: "overview.reason.device_permission_missing",
  device_handover_waiting: "overview.reason.device_handover_waiting",
  knowledge_review_due: "overview.reason.knowledge_review_due",
  folder_changed: "overview.reason.folder_changed",
} as const satisfies Record<AttentionItem["reason"], TranslationKey>;

const HELD_HOOK_KEYS = {
  execution_authority_required: "overview.reason.execution_authority_requiredHook",
  execution_authority_expired: "overview.reason.execution_authority_expiredHook",
  execution_authority_exhausted: "overview.reason.execution_authority_exhaustedHook",
  execution_authority_revoked: "overview.reason.execution_authority_revokedHook",
  execution_authority_changed: "overview.reason.execution_authority_changedHook",
} as const satisfies Partial<Record<AttentionItem["reason"], TranslationKey>>;

const REAPPROVAL_REASONS: ReadonlySet<AttentionItem["reason"]> = new Set([
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
]);

export const PAIR_WAITING_KIND = "pair_approval_waiting";

export function isPairWaiting(item: Pick<AttentionItem, "kind">): boolean {
  return item.kind === PAIR_WAITING_KIND;
}

export function attentionReason(item: Pick<AttentionItem, "kind" | "reason">): string {
  return isPairWaiting(item) ? PAIR_WAITING_KIND : item.reason;
}

const SUBJECT_KEYS = {
  workflow: "overview.subject.workflow",
  conversation: "overview.subject.conversation",
  connector: "overview.subject.connector",
  connection: "overview.subject.connection",
  secret: "overview.subject.secret",
  settings: "overview.subject.settings",
  task: "overview.subject.task",
  device: "overview.subject.device",
  knowledge: "overview.subject.knowledge",
} as const satisfies Record<NonNullable<AttentionItem["subject"]>["kind"], TranslationKey>;

const HEARTBEAT_KEYS: Record<string, TranslationKey> = {
  "self_healing.drift_scan": "overview.heartbeat.drift_scan",
  "connectors.reauth_scan": "overview.heartbeat.reauth_scan",
};

const SIGNAL_KEYS: Record<string, TranslationKey> = {
  pool_saturation: "overview.signal.pool_saturation",
  dlq_growth: "overview.signal.dlq_growth",
  transient_retry: "overview.signal.transient_retry",
  connector_unhealthy: "overview.signal.connector_unhealthy",
  llm_fallback: "overview.signal.llm_fallback",
  memory_high_water: "overview.signal.memory_high_water",
  llm_provider_quota: "overview.signal.llm_provider_quota",
  llm_provider_unavailable: "overview.signal.llm_provider_unavailable",
  llm_key_rejected: "overview.signal.llm_key_rejected",
};

interface AttentionSentence {
  lead: string;
  machine: string | null;
  since: string | null;
}

export const SUBJECT_NAME_MAX = 60;

function subjectName(item: AttentionItem): string | null {
  const name = item.subject?.name?.trim();
  return name ? clipAtWord(name, SUBJECT_NAME_MAX) : null;
}

function subjectPhrase(item: AttentionItem, t: Translate): string {
  if (!item.subject) return "";
  const name = subjectName(item);
  return t(SUBJECT_KEYS[item.subject.kind] ?? "overview.subject.other", {
    name: name ? t("overview.quoted", { name }) : t("overview.unnamed"),
  });
}

function counted(
  count: number | undefined,
  one: TranslationKey,
  many: TranslationKey,
  t: Translate,
): string {
  return t((count ?? 1) === 1 ? one : many, { count: count ?? 1 });
}

export function sinceLabel(since: string | null, now: number, t: Translate): string | null {
  if (!since) return null;
  const at = Date.parse(since);
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t("overview.since.now");
  if (minutes < 60) return counted(minutes, "overview.since.minute", "overview.since.minutes", t);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return counted(hours, "overview.since.hour", "overview.since.hours", t);
  const days = Math.floor(hours / 24);
  if (days < 14) return counted(days, "overview.since.day", "overview.since.days", t);
  const weeks = Math.floor(days / 7);
  if (days < 60) return counted(weeks, "overview.since.week", "overview.since.weeks", t);
  return counted(Math.floor(days / 30), "overview.since.month", "overview.since.months", t);
}

const DAY_MS = 86_400_000;

export function expiryDays(deadline: string | null, now: number): number | null {
  if (!deadline) return null;
  const end = Date.parse(deadline);
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - now) / DAY_MS));
}

export function attentionSentence(
  item: AttentionItem,
  t: Translate,
  now: number,
): AttentionSentence {
  const since = sinceLabel(item.since, now, t);
  const subject = subjectPhrase(item, t);
  const reasonKey = (REASON_KEYS as Record<string, TranslationKey>)[item.reason];
  if (!reasonKey) {
    return {
      lead: subject
        ? t("overview.reason.other", { subject })
        : t("overview.reason.otherWithoutSubject"),
      machine: item.reason,
      since,
    };
  }

  switch (item.reason) {
    case "execution_authority_required":
    case "execution_authority_expired":
    case "execution_authority_exhausted":
    case "execution_authority_revoked":
    case "execution_authority_changed": {
      if (item.reason === "execution_authority_required" && item.repair?.step_id)
        return { lead: heldRepairSentence(item, subject, t), machine: null, since };
      const hook = item.trigger?.kind === "inbound_hook" ? item.trigger.name : null;
      const held = hook
        ? t(HELD_HOOK_KEYS[item.reason], { subject, hook })
        : t(reasonKey, { subject });
      const detail = REAPPROVAL_REASONS.has(item.reason) ? null : attentionDetail(item, t);
      return {
        lead: detail ? t("overview.withCause", { sentence: held, cause: detail.text }) : held,
        machine: null,
        since,
      };
    }
    case "approval_expiring":
    case "task_grant_expiring": {
      const days = expiryDays(item.deadline, now);
      if (days === null) return { lead: t(reasonKey, { subject }), machine: null, since };
      const task = item.reason === "task_grant_expiring";
      return {
        lead: t(
          days === 0
            ? task
              ? "overview.expiry.grantToday"
              : "overview.expiry.approvalToday"
            : days === 1
              ? task
                ? "overview.expiry.grantTomorrow"
                : "overview.expiry.approvalTomorrow"
              : task
                ? "overview.expiry.grantDays"
                : "overview.expiry.approvalDays",
          { subject, count: days },
        ),
        machine: null,
        since,
      };
    }
    case "version_awaiting_approval": {
      const version = item.approval ? `v${item.approval.version}` : "";
      const key =
        item.trigger?.kind === "inbound_hook"
          ? item.trigger.name
            ? "overview.reason.version_awaiting_approvalHook"
            : "overview.reason.version_awaiting_approvalAny"
          : item.trigger?.kind === "schedule"
            ? reasonKey
            : "overview.reason.version_awaiting_approvalAny";
      const sentence = t(key, { subject, version, hook: item.trigger?.name ?? "" });
      const growth = growthLine(t, item.approval?.growth);
      return {
        lead: growth ? t("overview.withGrowth", { sentence, growth }) : sentence,
        machine: null,
        since,
      };
    }
    case "version_needs_repair":
      return { lead: repairSentence(item, subject, t), machine: null, since };
    case "ai_access_missing":
    case "model_tools_missing":
      return { lead: t(reasonKey), machine: null, since };
    case "pair_approval_requested":
      if (!isPairWaiting(item)) return { lead: t(reasonKey, { subject }), machine: null, since };
      return {
        lead: item.waiting_on?.name
          ? t("overview.reason.pair_approval_waiting", { subject, name: item.waiting_on.name })
          : t("overview.reason.pair_approval_waitingAnyone", { subject }),
        machine: null,
        since,
      };
    case "task_grant_required":
      return {
        lead: t(
          item.detail === "grant_required" ? "overview.reason.task_grant_requiredFirst" : reasonKey,
          { subject },
        ),
        machine: null,
        since,
      };
    case "failing": {
      const cause = item.cause_class ? causeClassKey(item.cause_class) : undefined;
      let lead = t(
        (item.counts.failures ?? 0) > 1
          ? "overview.reason.failingCount"
          : "overview.reason.failing",
        { subject, count: item.counts.failures ?? 1 },
      );
      if (cause) lead = t("overview.withCause", { sentence: lead, cause: t(cause) });
      if (item.counts.patches)
        lead = t("overview.withPatches", {
          sentence: lead,
          patches: counted(item.counts.patches, "overview.patches.one", "overview.patches.many", t),
        });
      const machine = item.cause_class && !cause ? item.cause_class : null;
      return { lead, machine, since };
    }
    case "patch_proposed":
      return {
        lead: t(
          (item.counts.patches ?? 1) > 1 ? "overview.reason.patch_proposedCount" : reasonKey,
          {
            subject,
            count: item.counts.patches ?? 1,
          },
        ),
        machine: null,
        since,
      };
    case "intake_collected":
      return {
        lead: t(
          (item.counts.intake ?? 1) > 1 ? "overview.reason.intake_collectedCount" : reasonKey,
          { count: item.counts.intake ?? 1 },
        ),
        machine: null,
        since,
      };
    case "knowledge_review_due":
      return {
        lead: t(
          (item.counts.knowledge_reviews ?? 1) > 1
            ? "overview.reason.knowledge_review_dueCount"
            : reasonKey,
          { subject, count: item.counts.knowledge_reviews ?? 1 },
        ),
        machine: null,
        since,
      };
    case "skills_proposed":
      return {
        lead: t(
          (item.counts.skills ?? 1) > 1 ? "overview.reason.skills_proposedCount" : reasonKey,
          {
            count: item.counts.skills ?? 1,
          },
        ),
        machine: null,
        since,
      };
    case "scheduler_stale": {
      const heartbeat = HEARTBEAT_KEYS[item.kind];
      return heartbeat
        ? { lead: t(reasonKey, { heartbeat: t(heartbeat) }), machine: null, since }
        : { lead: t("overview.reason.scheduler_staleOther"), machine: item.kind, since };
    }
    case "risk_critical": {
      const signal = SIGNAL_KEYS[item.kind];
      return signal
        ? { lead: t(reasonKey, { signal: t(signal) }), machine: null, since }
        : { lead: t("overview.reason.risk_criticalOther"), machine: item.kind, since };
    }
    default:
      return { lead: t(reasonKey, { subject }), machine: null, since };
  }
}

function repairCause(repair: NonNullable<AttentionItem["repair"]>, t: Translate): string {
  const own = `overview.repair.cause.${repair.code ?? ""}`;
  return t(
    Object.hasOwn(CATALOGS.en, own)
      ? (own as TranslationKey)
      : (`overview.repair.remedy.${repair.remedy_kind}` as TranslationKey),
  );
}

function withMoreSteps(sentence: string, steps: number, t: Translate): string {
  const more = steps - 1;
  if (more <= 0) return sentence;
  return t(more === 1 ? "overview.repair.more.one" : "overview.repair.more.many", {
    sentence,
    count: more,
  });
}

function heldRepairSentence(item: AttentionItem, subject: string, t: Translate): string {
  const repair = item.repair;
  if (!repair?.step_id) return t("overview.reason.execution_authority_required", { subject });
  const sentence = t("overview.reason.execution_authority_requiredStep", {
    subject,
    step: repair.step_id,
    cause: repairCause(repair, t),
  });
  return withMoreSteps(sentence, repair.steps, t);
}

function repairSentence(item: AttentionItem, subject: string, t: Translate): string {
  const version = item.approval ? `v${item.approval.version}` : "";
  const repair = item.repair;
  if (!repair?.step_id) return t("overview.reason.version_needs_repairBare", { subject, version });
  const sentence = t("overview.reason.version_needs_repair", {
    subject,
    version,
    step: repair.step_id,
    cause: repairCause(repair, t),
  });
  return withMoreSteps(sentence, repair.steps, t);
}

export function sentenceText(sentence: AttentionSentence): string {
  const machine = sentence.machine ? ` (${sentence.machine})` : "";
  const since = sentence.since ? ` — ${sentence.since}` : "";
  return `${sentence.lead}${machine}${since}.`;
}

export function entryActions(item: AttentionItem): {
  primary: AttentionAction | null;
  secondary: AttentionAction | null;
} {
  if (isPairWaiting(item)) return { primary: null, secondary: null };
  return projectedEntryActions(item);
}

export function signsInFromRow(action: AttentionAction, item: AttentionItem): boolean {
  if (item.reason === "approval_expiring" || item.reason === "task_grant_expiring") return false;
  const kind = item.subject?.kind;
  if (kind !== "connector" && kind !== "connection") return false;
  return action.verb === "reauth" || action.verb === "renew";
}

export function attentionTarget(action: AttentionAction, item: AttentionItem): string {
  if (item.reason !== "schedule_auto_paused" || item.subject?.kind !== "workflow")
    return action.href;
  return autoPauseRemedy({ failure_class: item.detail ?? "" }) === "renew_approval"
    ? workflowAutomationHref(item.subject.id)
    : `${workflowHref(item.subject.id)}?tab=schedule`;
}

export function actionLabelKey(action: AttentionAction, item: AttentionItem): TranslationKey {
  switch (action.verb) {
    case "review":
      return item.reason === "task_result_ready"
        ? "overview.action.reviewResult"
        : "overview.action.review";
    case "open":
      if (item.reason === "task_grant_required") return "overview.action.allow";
      if (item.reason === "task_owner_unavailable") return "overview.action.resume";
      if (item.subject?.kind === "task") return "overview.action.openTask";
      if (item.reason === "version_awaiting_approval" || REAPPROVAL_REASONS.has(item.reason))
        return "overview.action.approve";
      if (item.reason === "input_required") return "overview.action.addInput";
      if (item.reason === "device_handover_waiting") return "overview.action.takeOver";
      if (item.reason === "knowledge_review_due") return "overview.action.reviewKnowledge";
      if (item.reason === "version_needs_repair" || item.reason === "execution_authority_required")
        return item.repair?.remedy_kind === "prepare"
          ? "overview.action.prepare"
          : item.repair?.remedy_kind === "patch"
            ? "diagnosis.repair"
            : "overview.action.fix";
      if (item.reason === "approval_expiring") return "overview.action.renewApproval";
      if (item.reason === "schedule_auto_paused")
        return autoPauseRemedy({ failure_class: item.detail ?? "" }) === "renew_approval"
          ? "scheduleAutoPause.renew"
          : "scheduleAutoPause.resume";
      if (item.reason === "secret_prepared") return "overview.action.openSettings";
      if (item.reason === "spend_warning") return "overview.action.openUsage";
      if (item.reason === "spend_limit_reached" && action.href.includes("spend="))
        return action.primary ? "us.spendRaise" : "us.spendContinue";
      if (item.reason === "spend_limit_reached") return "overview.action.openUsage";
      if (item.reason === "spend_limit_unset") return "overview.action.setUp";
      if (item.reason === "ai_access_missing") return "overview.action.setUp";
      if (item.reason === "model_tools_missing") return "overview.action.openSettings";
      if (item.kind.startsWith("llm_provider_")) return "overview.action.openSettings";
      if (item.subject?.kind === "connector") return "overview.action.openConnector";
      return "overview.action.openOperations";
    case "answer":
      return "overview.action.answer";
    case "reauth":
      return "overview.action.reauth";
    case "renew":
      if (item.reason === "approval_expiring" || item.reason === "task_grant_expiring")
        return "overview.action.renewApproval";
      return item.subject?.kind === "task" ? "overview.action.extend" : "overview.action.renew";
    case "open_runs":
      return "overview.action.openRuns";
    case "chat":
      return item.reason === "version_needs_repair" ||
        item.reason === "execution_authority_required"
        ? "remedy.chat"
        : "overview.action.chat";
    default:
      return "overview.action.openOperations";
  }
}

const SOURCE_KEYS = {
  conversations: "overview.source.conversations",
  schedules: "overview.source.schedules",
  freshness: "overview.source.freshness",
  failures: "overview.source.failures",
  patches: "overview.source.patches",
  connectors: "overview.source.connectors",
  connections: "overview.source.connections",
  secret_approvals: "overview.source.secret_approvals",
  knowledge: "overview.source.knowledge",
  skills: "overview.source.skills",
  intake: "overview.source.intake",
  budget: "overview.source.budget",
  ai_access: "overview.source.ai_access",
  risk: "overview.source.risk",
  tasks: "overview.source.tasks",
} as const satisfies Record<AttentionSource, TranslationKey>;

export function sourceLabel(source: AttentionSource, t: Translate): string {
  return t(SOURCE_KEYS[source]);
}

const HEALTH_KEYS = {
  healthy: "overview.health.healthy",
  limited: "overview.health.limited",
  critical: "overview.health.critical",
  unknown: "overview.health.unknown",
} as const satisfies Record<HealthState, TranslationKey>;

export function statusLine(
  status: Attention["status"],
  t: Translate,
  dateTime: (value: string) => string,
): string | null {
  if (!status) return null;
  const health = t(HEALTH_KEYS[status.health_state] ?? "overview.health.unknown");
  const next = status.next_run_at
    ? t("overview.status.nextRun", { when: dateTime(status.next_run_at) })
    : t("overview.status.noRun");
  return `${health} · ${next}`;
}

function reviewLink(href: string): boolean {
  const query = href.indexOf("?");
  if (query < 0) return false;
  return reviewFromUrl(href.slice(query).split("#")[0] ?? "") !== null;
}

export function opensReviewSheet(item: AttentionItem, action: AttentionAction): boolean {
  return navigationOpensReviewSheet(item, action, reviewLink);
}

export function reviewForward(
  action: AttentionAction | null,
  access: ReviewAccess,
): AttentionAction | null {
  return navigationReviewForward(action, access, reviewLink);
}

export interface ReviewHistory {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url: string): void;
  replaceState(state: unknown, unused: string, url: string): void;
  back(): void;
}

const OPENED_HERE = "sk-attention-review";

export function reviewNavigation(history: ReviewHistory, href: (review: string | null) => string) {
  return {
    open(review: string): void {
      history.pushState({ [OPENED_HERE]: true }, "", href(review));
    },
    close(): void {
      const state = history.state as Record<string, unknown> | null;
      if (state?.[OPENED_HERE]) history.back();
      else history.replaceState(history.state, "", href(null));
    },
  };
}

const SHORT_REASON_KEYS = {
  awaiting_answer: "overview.short.awaiting_answer",
  execution_authority_required: "overview.short.execution_authority_required",
  execution_authority_expired: "overview.short.execution_authority_expired",
  execution_authority_exhausted: "overview.short.execution_authority_exhausted",
  execution_authority_revoked: "overview.short.execution_authority_revoked",
  execution_authority_changed: "overview.short.execution_authority_changed",
  input_required: "overview.short.input_required",
  version_awaiting_approval: "overview.short.version_awaiting_approval",
  approval_expiring: "overview.short.approval_expiring",
  schedule_auto_paused: "overview.short.schedule_auto_paused",
  scheduler_stale: "overview.short.scheduler_stale",
  needs_reauth: "overview.short.needs_reauth",
  needs_update: "overview.short.needs_update",
  degraded: "connectors.healthState.degraded",
  unhealthy: "overview.short.unhealthy",
  refresh_refused: "overview.short.refresh_refused",
  refresh_failed: "overview.short.refresh_failed",
  expired_no_refresh: "overview.short.expired_no_refresh",
  secret_unreadable: "overview.short.secret_unreadable",
  secret_prepared: "overview.short.secret_prepared",
  spend_warning: "overview.short.spend_warning",
  spend_limit_reached: "overview.short.spend_limit_reached",
  spend_limit_unset: "overview.short.spend_limit_unset",
  ai_access_missing: "overview.short.ai_access_missing",
  model_tools_missing: "overview.short.model_tools_missing",
  risk_critical: "overview.short.risk_critical",
  task_run_failed: "overview.short.task_run_failed",
  task_result_ready: "overview.short.task_result_ready",
  task_grant_required: "overview.short.task_grant_required",
  task_grant_expiring: "overview.short.task_grant_expiring",
  task_owner_unavailable: "overview.short.task_owner_unavailable",
  pair_approval_requested: "overview.short.pair_approval_requested",
  device_offline_waiting: "overview.short.device_offline_waiting",
  local_confirmation_needed: "overview.short.local_confirmation_needed",
  payment_approval_needed: "overview.short.payment_approval_needed",
  sign_in_confirmation_needed: "overview.short.sign_in_confirmation_needed",
  device_permission_missing: "overview.short.device_permission_missing",
  device_handover_waiting: "overview.short.device_handover_waiting",
  knowledge_review_due: "overview.short.knowledge_review_due",
  folder_changed: "overview.short.folder_changed",
} as const satisfies Partial<Record<AttentionItem["reason"], TranslationKey>>;

const COUNTED_SHORT_REASON_KEYS = {
  version_needs_repair: "overview.short.version_needs_repair",
  failing: "overview.short.failing",
  patch_proposed: "overview.short.patch_proposed",
  skills_proposed: "overview.short.skills_proposed",
  intake_collected: "overview.short.intake_collected",
} as const satisfies Partial<Record<AttentionItem["reason"], PluralKey>>;

const STATE_OF_REASON: Record<AttentionItem["reason"], { state: string; label: TranslationKey }> = {
  awaiting_answer: { state: "pending", label: "overview.state.answer" },
  execution_authority_required: { state: "needs_attention", label: "automation.state.repair" },
  execution_authority_expired: { state: "pending", label: "workflowStrip.state.grant" },
  execution_authority_exhausted: { state: "pending", label: "workflowStrip.state.grant" },
  execution_authority_revoked: { state: "pending", label: "workflowStrip.state.grant" },
  execution_authority_changed: { state: "pending", label: "workflowStrip.state.grant" },
  input_required: { state: "needs_attention", label: "automation.state.repair" },
  version_awaiting_approval: { state: "pending", label: "workflowStrip.state.grant" },
  version_needs_repair: { state: "needs_attention", label: "automation.state.repair" },
  approval_expiring: { state: "expiring", label: "workflowStrip.state.expiring" },
  schedule_auto_paused: { state: "needs_attention", label: "overview.state.autoPaused" },
  scheduler_stale: { state: "degraded", label: "overview.state.stale" },
  failing: { state: "failed", label: "workflowStrip.state.failing" },
  patch_proposed: { state: "proposed", label: "workflowStrip.state.repairPrepared" },
  needs_reauth: { state: "expired", label: "connectorStrip.state.expired" },
  needs_update: { state: "needs_update", label: "connectors.healthState.needsUpdate" },
  degraded: { state: "degraded", label: "connectors.healthState.degraded" },
  unhealthy: { state: "failed", label: "workflowStrip.state.failing" },
  refresh_refused: { state: "expired", label: "connectorStrip.state.expired" },
  refresh_failed: { state: "expired", label: "connectorStrip.state.expired" },
  expired_no_refresh: { state: "expired", label: "connectorStrip.state.expired" },
  secret_unreadable: { state: "failed", label: "overview.state.secret" },
  secret_prepared: { state: "pending", label: "overview.state.decide" },
  skills_proposed: { state: "proposed", label: "overview.state.decide" },
  intake_collected: { state: "pending", label: "overview.state.decide" },
  spend_warning: { state: "pending", label: "overview.state.budget" },
  spend_limit_reached: { state: "critical", label: "overview.state.budget" },
  spend_limit_unset: { state: "pending", label: "overview.state.decide" },
  ai_access_missing: { state: "pending", label: "settings.status.waiting" },
  model_tools_missing: { state: "pending", label: "overview.state.decide" },
  risk_critical: { state: "critical", label: "overview.state.risk" },
  task_run_failed: { state: "failed", label: "status.failed" },
  task_result_ready: { state: "pending", label: "overview.state.taskResult" },
  task_grant_required: { state: "pending", label: "overview.state.taskAllow" },
  task_grant_expiring: { state: "expiring", label: "overview.state.taskExpiring" },
  task_owner_unavailable: { state: "needs_attention", label: "overview.state.autoPaused" },
  pair_approval_requested: { state: "pending", label: "ops.pair.waitingSecond" },
  device_offline_waiting: { state: "pending", label: "settings.status.waiting" },
  local_confirmation_needed: { state: "pending", label: "overview.state.decide" },
  payment_approval_needed: { state: "pending", label: "overview.state.decide" },
  sign_in_confirmation_needed: { state: "pending", label: "overview.state.decide" },
  device_permission_missing: { state: "needs_attention", label: "automation.state.repair" },
  device_handover_waiting: { state: "pending", label: "overview.state.decide" },
  knowledge_review_due: { state: "pending", label: "overview.state.decide" },
  folder_changed: { state: "needs_attention", label: "automation.state.repair" },
};

const PAIR_WAITING_BADGE = { state: "pending", label: "overview.state.pairWaiting" } as const;

interface AttentionRow {
  name: string;
  reason: string;
  machine: string | null;
  waitingOn: string | null;
  badge: { state: string; label: TranslationKey };
}

export function waitingOnName(
  attention: Pick<Attention, "items"> | undefined,
  subjectId: string | null | undefined,
): string | null {
  if (!attention || !subjectId) return null;
  const item = attention.items.find(
    (entry) => entry.subject?.id === subjectId && entry.waiting_on?.name,
  );
  return item?.waiting_on?.name ?? null;
}

export function pairWaitingFor(
  attention: Pick<Attention, "items"> | undefined,
  subjectId: string | null | undefined,
): { waitingOn: string | null } | null {
  if (!attention || !subjectId) return null;
  const item = attention.items.find(
    (entry) => isPairWaiting(entry) && entry.subject?.id === subjectId,
  );
  return item ? { waitingOn: item.waiting_on?.name ?? null } : null;
}

export function waitingOnLine(name: string, t: Translate): string {
  return t("overview.waitingOn", { name });
}

export function isEndpointRetiring(item: Pick<AttentionItem, "reason" | "class">): boolean {
  return item.reason === "needs_update" && item.class !== "failing";
}

const RETIRING_BADGE = { state: "needs_update", label: "connectors.healthState.retiring" } as const;

function retiringReason(
  item: Pick<AttentionItem, "deadline">,
  t: Translate,
  day: (value: string) => string,
): string {
  const at = item.deadline ? Date.parse(item.deadline) : Number.NaN;
  return Number.isNaN(at)
    ? t("overview.short.endpoint_retiringUndated")
    : t("overview.short.endpoint_retiring", { date: day(item.deadline as string) });
}

export function attentionRow(
  item: AttentionItem,
  t: Translate,
  day: (value: string) => string = (value) => value.slice(0, 10),
): AttentionRow {
  const name =
    (item.reason === "ai_access_missing" || item.reason === "model_tools_missing"
      ? t("overview.object.aiAccess")
      : subjectName(item)) ||
    (item.reason === "skills_proposed"
      ? t("overview.object.skills")
      : item.reason === "intake_collected"
        ? t("overview.object.intake")
        : item.reason === "knowledge_review_due"
          ? t("overview.object.knowledge")
          : item.reason === "spend_warning" ||
              item.reason === "spend_limit_reached" ||
              item.reason === "spend_limit_unset"
            ? t("overview.object.budget")
            : t("overview.unnamed"));
  const version = item.approval ? ` v${item.approval.version}` : "";

  const retiring = isEndpointRetiring(item);
  const badge = isPairWaiting(item)
    ? PAIR_WAITING_BADGE
    : retiring
      ? RETIRING_BADGE
      : ((STATE_OF_REASON as Record<string, AttentionRow["badge"]>)[item.reason] ?? {
          state: "pending",
          label: "overview.state.decide",
        });
  const count =
    item.reason === "failing"
      ? (item.counts.failures ?? 1)
      : item.reason === "patch_proposed"
        ? (item.counts.patches ?? 1)
        : item.reason === "skills_proposed"
          ? (item.counts.skills ?? 1)
          : item.reason === "intake_collected"
            ? (item.counts.intake ?? 1)
            : (item.repair?.steps ?? 1);
  const counted =
    item.reason === "execution_authority_required" && item.repair?.step_id
      ? COUNTED_SHORT_REASON_KEYS.version_needs_repair
      : (COUNTED_SHORT_REASON_KEYS as Record<string, PluralKey>)[item.reason];
  const key = isPairWaiting(item)
    ? item.waiting_on?.name
      ? "overview.short.pair_approval_waiting"
      : "overview.short.pair_approval_waitingAnyone"
    : counted
      ? pluralKey(counted, count)
      : (SHORT_REASON_KEYS as Record<string, TranslationKey>)[item.reason];
  const short = retiring
    ? retiringReason(item, t, day)
    : key
      ? t(key, { count, step: item.repair?.step_id ?? "" })
      : t("overview.short.other");
  return {
    name: `${name}${version}`,
    reason: short,
    machine: key ? null : item.reason,
    waitingOn: item.waiting_on?.name ? waitingOnLine(item.waiting_on.name, t) : null,
    badge,
  };
}

export function attentionDetail(
  item: { reason: string; cause_class?: string | null; detail?: string | null },
  t: Translate,
): EngineSentence | null {
  if (!item.detail?.trim() || item.reason in VAULT_REASON_KEYS) return null;
  return engineSentence({ hold: item.reason, cause_class: item.cause_class, text: item.detail }, t);
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function vaultAttentionFacts(
  item: Pick<AttentionItem, "vault">,
  locale: Locale,
): string | null {
  const vault = item.vault;
  if (!vault) return null;
  const amount =
    typeof vault.amount_minor === "number" && vault.currency
      ? formatMinor(locale, vault.amount_minor, vault.currency.toUpperCase())
      : null;
  const card = vault.card ? cardLabel(vault.card) : null;
  return [hostOf(vault.origin), amount, card].filter(Boolean).join(" · ");
}

export function attentionEnvironment(
  item: Pick<AttentionItem, "approval" | "subject">,
): "dev" | "prod" | null {
  return item.approval?.environment ?? item.subject?.environment ?? null;
}
