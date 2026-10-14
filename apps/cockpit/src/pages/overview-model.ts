import type { components } from "@/api/schema";
import { growthLine } from "@/lib/authority-growth";
import { causeClassKey } from "@/lib/cause-class";
import { CATALOGS, type PluralKey, pluralKey, type TranslationKey } from "@/lib/i18n";
import { clipAtWord } from "@/lib/presentation";

export type Attention = components["schemas"]["AttentionV1"];
export type AttentionItem = components["schemas"]["AttentionItem"];
export type AttentionAction = components["schemas"]["AttentionAction"];
export type AttentionSource = keyof Attention["sources"];
export type HealthState = NonNullable<Attention["status"]>["health_state"];

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export type HiddenEntries = ReadonlyMap<string, string>;
export const NO_HIDDEN: HiddenEntries = new Map();

export function entrySnapshot(item: AttentionItem): string {
  return JSON.stringify([
    item.reason,
    item.class,
    item.counts,
    item.actions.find((action) => action.primary)?.verb ?? null,
  ]);
}

export function isHidden(item: AttentionItem, hidden: HiddenEntries): boolean {
  return hidden.get(item.id) === entrySnapshot(item);
}

export function settleHidden(
  hidden: HiddenEntries,
  items: readonly AttentionItem[],
): HiddenEntries {
  const byId = new Map(items.map((item) => [item.id, item]));
  const next = new Map(
    [...hidden].filter(([id, snapshot]) => {
      const item = byId.get(id);
      return item !== undefined && entrySnapshot(item) === snapshot;
    }),
  );
  return next.size === hidden.size ? hidden : next;
}

export function subjectKey(item: AttentionItem): string {
  return item.subject ? `${item.subject.kind}:${item.subject.id}` : item.id;
}

export function attentionEntries(
  items: readonly AttentionItem[],
  hidden: HiddenEntries = NO_HIDDEN,
): AttentionItem[] {
  const seen = new Set<string>();
  const entries: AttentionItem[] = [];
  for (const item of items) {
    if (isHidden(item, hidden)) continue;
    const key = subjectKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(item);
  }
  return entries;
}

export type OverviewView =
  | { kind: "items"; items: AttentionItem[]; unread: AttentionSource[] }
  | { kind: "calm"; status: Attention["status"] }
  | { kind: "unread"; unread: AttentionSource[] }
  | { kind: "nothing_readable" };

export function failedSources(attention: Attention): AttentionSource[] {
  return (Object.keys(attention.sources) as AttentionSource[]).filter(
    (source) => attention.sources[source] === "failed",
  );
}

export function overviewView(
  attention: Attention,
  hidden: HiddenEntries = NO_HIDDEN,
): OverviewView {
  const items = attentionEntries(attention.items, hidden);
  const unread = failedSources(attention);
  if (items.length > 0) return { kind: "items", items, unread };
  if (unread.length > 0) return { kind: "unread", unread };
  const readable = Object.values(attention.sources).some((state) => state !== "not_permitted");
  if (!readable) return { kind: "nothing_readable" };
  return { kind: "calm", status: attention.status };
}

export type OverviewSection = "operations" | "attention" | "calm" | "unread" | "history";

export function overviewSections(
  view: OverviewView,
  can: { operations: boolean; history: boolean },
): OverviewSection[] {
  const sections: OverviewSection[] = can.operations ? ["operations"] : [];
  if (view.kind === "items") {
    sections.push("attention");
    if (view.unread.length > 0) sections.push("unread");
  } else if (view.kind === "calm") sections.push("calm");
  else if (view.kind === "unread") sections.push("unread");
  if (can.history) sections.push("history");
  return sections;
}

export function attentionBadge(
  attention: Attention | undefined,
  hidden: HiddenEntries = NO_HIDDEN,
): { count: number; stopped: boolean } | null {
  if (!attention) return null;
  const items = attentionEntries(attention.items, hidden);
  if (items.length === 0) return null;
  return { count: items.length, stopped: items.some((item) => item.class === "stopped") };
}

const REASON_KEYS = {
  awaiting_answer: "overview.reason.awaiting_answer",
  execution_authority_required: "overview.reason.execution_authority_required",
  execution_authority_unavailable: "overview.reason.execution_authority_unavailable",
  version_awaiting_approval: "overview.reason.version_awaiting_approval",
  version_needs_repair: "overview.reason.version_needs_repair",
  approval_expiring: "overview.reason.approval_expiring",
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
  budget_critical: "overview.reason.budget_critical",
  risk_critical: "overview.reason.risk_critical",
} as const satisfies Record<AttentionItem["reason"], TranslationKey>;

const SUBJECT_KEYS = {
  workflow: "overview.subject.workflow",
  conversation: "overview.subject.conversation",
  connector: "overview.subject.connector",
  connection: "overview.subject.connection",
  secret: "overview.subject.secret",
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
  token_budget: "overview.signal.token_budget",
};

export interface AttentionSentence {
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
    case "execution_authority_unavailable": {
      const hook = item.trigger?.kind === "inbound_hook" ? item.trigger.name : null;
      if (!hook) return { lead: t(reasonKey, { subject }), machine: null, since };
      return {
        lead: t(
          item.reason === "execution_authority_required"
            ? "overview.reason.execution_authority_requiredHook"
            : "overview.reason.execution_authority_unavailableHook",
          { subject, hook },
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

function repairSentence(item: AttentionItem, subject: string, t: Translate): string {
  const version = item.approval ? `v${item.approval.version}` : "";
  const repair = item.repair;
  if (!repair?.step_id) return t("overview.reason.version_needs_repairBare", { subject, version });
  const own = `overview.repair.cause.${repair.code ?? ""}`;
  const cause = t(
    Object.hasOwn(CATALOGS.en, own)
      ? (own as TranslationKey)
      : (`overview.repair.remedy.${repair.remedy_kind}` as TranslationKey),
  );
  const sentence = t("overview.reason.version_needs_repair", {
    subject,
    version,
    step: repair.step_id,
    cause,
  });
  const more = repair.steps - 1;
  if (more <= 0) return sentence;
  return t(more === 1 ? "overview.repair.more.one" : "overview.repair.more.many", {
    sentence,
    count: more,
  });
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
  const primary = item.actions.find((action) => action.primary) ?? null;
  const secondary = item.actions.find((action) => !action.primary) ?? null;
  return { primary, secondary };
}

export function actionLabelKey(action: AttentionAction, item: AttentionItem): TranslationKey {
  switch (action.verb) {
    case "review":
      return "overview.action.review";
    case "open":
      if (item.reason === "version_awaiting_approval") return "overview.action.approve";
      if (item.reason === "version_needs_repair")
        return item.repair?.remedy_kind === "prepare"
          ? "overview.action.prepare"
          : item.repair?.remedy_kind === "patch"
            ? "diagnosis.repair"
            : "overview.action.fix";
      if (item.reason === "approval_expiring") return "overview.action.extend";
      if (item.reason === "secret_prepared") return "overview.action.openSettings";
      if (item.reason === "budget_critical") return "overview.action.openUsage";
      if (item.subject?.kind === "connector") return "overview.action.openConnector";
      return "overview.action.openOperations";
    case "answer":
      return "overview.action.answer";
    case "reauth":
      return "overview.action.reauth";
    case "renew":
      return "overview.action.renew";
    case "open_runs":
      return "overview.action.openRuns";
    case "chat":
      return item.reason === "version_needs_repair" ? "remedy.chat" : "overview.action.chat";
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
  skills: "overview.source.skills",
  budget: "overview.source.budget",
  risk: "overview.source.risk",
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

export type ReviewTarget =
  | { kind: "workflow"; workflowId: string }
  | { kind: "skills" }
  | { kind: "other" };

export function reviewTarget(id: string): ReviewTarget {
  if (id === "skills") return { kind: "skills" };
  const match = /^workflow:([0-9a-f-]{36})$/i.exec(id);
  if (match?.[1]) return { kind: "workflow", workflowId: match[1] };
  return { kind: "other" };
}

export type ReviewAccess = "readable" | "not_permitted" | "nothing";

export function reviewAccess(target: ReviewTarget, permissions: readonly string[]): ReviewAccess {
  if (target.kind === "workflow")
    return permissions.includes("workflow:read") ? "readable" : "not_permitted";
  if (target.kind === "skills")
    return permissions.includes("skill:read") ? "readable" : "not_permitted";
  return "nothing";
}

export function reviewSettles(review: {
  openBefore: number | null;
  openNow: number;
  listedBefore: boolean;
  listedNow: boolean;
}): boolean {
  if (review.openNow > 0) return false;
  if (review.openBefore !== null && review.openBefore > 0) return true;
  return review.listedBefore && !review.listedNow;
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
  execution_authority_unavailable: "overview.short.execution_authority_unavailable",
  version_awaiting_approval: "overview.short.version_awaiting_approval",
  approval_expiring: "overview.short.approval_expiring",
  scheduler_stale: "overview.short.scheduler_stale",
  needs_reauth: "overview.short.needs_reauth",
  needs_update: "overview.short.needs_update",
  degraded: "overview.short.degraded",
  unhealthy: "overview.short.unhealthy",
  refresh_refused: "overview.short.refresh_refused",
  refresh_failed: "overview.short.refresh_failed",
  expired_no_refresh: "overview.short.expired_no_refresh",
  secret_unreadable: "overview.short.secret_unreadable",
  secret_prepared: "overview.short.secret_prepared",
  budget_critical: "overview.short.budget_critical",
  risk_critical: "overview.short.risk_critical",
} as const satisfies Partial<Record<AttentionItem["reason"], TranslationKey>>;

const COUNTED_SHORT_REASON_KEYS = {
  version_needs_repair: "overview.short.version_needs_repair",
  failing: "overview.short.failing",
  patch_proposed: "overview.short.patch_proposed",
  skills_proposed: "overview.short.skills_proposed",
} as const satisfies Partial<Record<AttentionItem["reason"], PluralKey>>;

const STATE_OF_REASON: Record<AttentionItem["reason"], { state: string; label: TranslationKey }> = {
  awaiting_answer: { state: "pending", label: "overview.state.answer" },
  execution_authority_required: { state: "pending", label: "workflowStrip.state.grant" },
  execution_authority_unavailable: { state: "failed", label: "workflowStrip.state.stopped" },
  version_awaiting_approval: { state: "pending", label: "workflowStrip.state.grant" },
  version_needs_repair: { state: "needs_attention", label: "automation.state.repair" },
  approval_expiring: { state: "expiring", label: "workflowStrip.state.expiring" },
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
  budget_critical: { state: "critical", label: "overview.state.budget" },
  risk_critical: { state: "critical", label: "overview.state.risk" },
};

export interface AttentionRow {
  name: string;
  reason: string;
  machine: string | null;
  badge: { state: string; label: TranslationKey };
}

export function attentionRow(item: AttentionItem, t: Translate): AttentionRow {
  const name =
    subjectName(item) ||
    (item.reason === "skills_proposed"
      ? t("overview.object.skills")
      : item.reason === "budget_critical"
        ? t("overview.object.budget")
        : t("overview.unnamed"));
  const version = item.approval ? ` v${item.approval.version}` : "";

  const badge = (STATE_OF_REASON as Record<string, AttentionRow["badge"]>)[item.reason] ?? {
    state: "pending",
    label: "overview.state.decide",
  };
  const count =
    item.reason === "failing"
      ? (item.counts.failures ?? 1)
      : item.reason === "patch_proposed"
        ? (item.counts.patches ?? 1)
        : item.reason === "skills_proposed"
          ? (item.counts.skills ?? 1)
          : (item.repair?.steps ?? 1);
  const counted = (COUNTED_SHORT_REASON_KEYS as Record<string, PluralKey>)[item.reason];
  const key = counted
    ? pluralKey(counted, count)
    : (SHORT_REASON_KEYS as Record<string, TranslationKey>)[item.reason];
  const short = key
    ? t(key, { count, step: item.repair?.step_id ?? "" })
    : t("overview.short.other");
  const knowledge = item.reason === "skills_proposed" ? (item.counts.knowledge ?? 0) : 0;
  return {
    name: `${name}${version}`,
    reason:
      knowledge > 0
        ? t("overview.short.skills_proposedSplit", {
            proposals: short,
            knowledge,
            skills: count - knowledge,
          })
        : short,
    machine: key ? null : item.reason,
    badge,
  };
}
