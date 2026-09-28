// Heute — the one list of what needs the reader now — as pure functions.
//
// The engine answers the question once (`GET /v1/attention`, attention.v1) and
// hands over facts, never sentences: a subject, a machine reason, counts, since
// when. Everything a person reads on the list is composed HERE, in the reader's
// language. The engine's residual wording (`detail`) is not part of a list
// entry; the review sheet shows it, marked as the engine's.
//
// The rules that decide what the page says when the list is empty live here too,
// because they are the part that can lie: "Alles erledigt" is only true when
// every source this person may read has answered.

import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

export type Attention = components["schemas"]["AttentionV1"];
export type AttentionItem = components["schemas"]["AttentionItem"];
export type AttentionAction = components["schemas"]["AttentionAction"];
export type AttentionSource = keyof Attention["sources"];
export type HealthState = NonNullable<Attention["status"]>["health_state"];

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

// --------------------------------------------------------------------------
// One entry per subject.

/** The thing an entry is about — its subject, or the entry itself where it has none. */
export function subjectKey(item: AttentionItem): string {
  return item.subject ? `${item.subject.kind}:${item.subject.id}` : item.id;
}

/**
 * The entries in the engine's order, one per subject.
 *
 * The engine already merges a workflow's held schedule, failures and open fixes
 * into one entry. Held here as well, because a second line about the same
 * workflow is a second place to act on it — the defect this page exists to end.
 * The first entry wins: the engine orders the most pressing first.
 */
export function attentionEntries(
  items: readonly AttentionItem[],
  hidden: ReadonlySet<string> = new Set(),
): AttentionItem[] {
  const seen = new Set<string>();
  const entries: AttentionItem[] = [];
  for (const item of items) {
    if (hidden.has(item.id)) continue;
    const key = subjectKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(item);
  }
  return entries;
}

// --------------------------------------------------------------------------
// What the page says.

export type TodayView =
  /** Entries to act on. `unread` names the sources that could not be read. */
  | { kind: "items"; items: AttentionItem[]; unread: AttentionSource[] }
  /** Nothing open, and every readable source answered. */
  | { kind: "calm"; status: Attention["status"] }
  /** Nothing listed, but a source failed: no "all done", say what is missing. */
  | { kind: "unread"; unread: AttentionSource[] }
  /** This person may read no source at all. */
  | { kind: "nothing_readable" };

export function failedSources(attention: Attention): AttentionSource[] {
  return (Object.keys(attention.sources) as AttentionSource[]).filter(
    (source) => attention.sources[source] === "failed",
  );
}

/**
 * The page's state, from the engine's answer.
 *
 * A source the reader may not read (`not_permitted`) is simply absent — it is
 * neither an entry nor a gap. A source that FAILED is never counted as empty:
 * without it the list could be missing exactly the entry that matters, and
 * "Alles erledigt" would be a claim nobody checked.
 */
export function todayView(
  attention: Attention,
  hidden: ReadonlySet<string> = new Set(),
): TodayView {
  const items = attentionEntries(attention.items, hidden);
  const unread = failedSources(attention);
  if (items.length > 0) return { kind: "items", items, unread };
  if (unread.length > 0) return { kind: "unread", unread };
  const readable = Object.values(attention.sources).some((state) => state !== "not_permitted");
  if (!readable) return { kind: "nothing_readable" };
  return { kind: "calm", status: attention.status };
}

/**
 * The navigation badge: the number of entries, red when anything is stopped,
 * absent at zero and while the list cannot be read. A stale or guessed number
 * is worse than none.
 */
export function attentionBadge(
  attention: Attention | undefined,
  hidden: ReadonlySet<string> = new Set(),
): { count: number; stopped: boolean } | null {
  if (!attention) return null;
  const items = attentionEntries(attention.items, hidden);
  if (items.length === 0) return null;
  return { count: items.length, stopped: items.some((item) => item.class === "stopped") };
}

// --------------------------------------------------------------------------
// The sentence.

const REASON_KEYS = {
  awaiting_answer: "today.reason.awaiting_answer",
  execution_authority_required: "today.reason.execution_authority_required",
  execution_authority_unavailable: "today.reason.execution_authority_unavailable",
  scheduler_stale: "today.reason.scheduler_stale",
  failing: "today.reason.failing",
  patch_proposed: "today.reason.patch_proposed",
  needs_reauth: "today.reason.needs_reauth",
  needs_update: "today.reason.needs_update",
  degraded: "today.reason.degraded",
  unhealthy: "today.reason.unhealthy",
  refresh_refused: "today.reason.refresh_refused",
  refresh_failed: "today.reason.refresh_failed",
  expired_no_refresh: "today.reason.expired_no_refresh",
  secret_unreadable: "today.reason.secret_unreadable",
  secret_prepared: "today.reason.secret_prepared",
  skills_proposed: "today.reason.skills_proposed",
  budget_critical: "today.reason.budget_critical",
  risk_critical: "today.reason.risk_critical",
} as const satisfies Record<AttentionItem["reason"], TranslationKey>;

const SUBJECT_KEYS = {
  workflow: "today.subject.workflow",
  conversation: "today.subject.conversation",
  connector: "today.subject.connector",
  connection: "today.subject.connection",
  secret: "today.subject.secret",
} as const satisfies Record<NonNullable<AttentionItem["subject"]>["kind"], TranslationKey>;

const CAUSE_KEYS: Record<string, TranslationKey> = {
  ok: "cause.ok",
  auth_failed: "cause.auth_failed",
  placeholder_unresolved: "cause.placeholder_unresolved",
  schema_mismatch: "cause.schema_mismatch",
  timeout: "cause.timeout",
  aborted: "cause.aborted",
  connector_missing: "cause.connector_missing",
  budget_exhausted: "cause.budget_exhausted",
  driver_error: "cause.driver_error",
  preview_unsupported: "cause.preview_unsupported",
  unknown: "cause.unknown",
};

/** The heartbeats the scheduler writes (operator/operational-overview.ts). */
const HEARTBEAT_KEYS: Record<string, TranslationKey> = {
  "self_healing.drift_scan": "today.heartbeat.drift_scan",
  "connectors.reauth_scan": "today.heartbeat.reauth_scan",
};

/** The critical signals the engine raises (operator/risk-signals.ts). */
const SIGNAL_KEYS: Record<string, TranslationKey> = {
  pool_saturation: "today.signal.pool_saturation",
  dlq_growth: "today.signal.dlq_growth",
  transient_retry: "today.signal.transient_retry",
  connector_unhealthy: "today.signal.connector_unhealthy",
  llm_fallback: "today.signal.llm_fallback",
  memory_high_water: "today.signal.memory_high_water",
  token_budget: "today.signal.token_budget",
};

export interface AttentionSentence {
  /** The cockpit's own words. */
  lead: string;
  /** A value this build has no word for, shown as the engine's value (§15.2). */
  machine: string | null;
  /** "seit 3 Tagen", or null when the engine names no start. */
  since: string | null;
}

function subjectPhrase(item: AttentionItem, t: Translate): string {
  if (!item.subject) return "";
  const name = item.subject.name?.trim();
  return t(SUBJECT_KEYS[item.subject.kind] ?? "today.subject.other", {
    name: name ? t("today.quoted", { name }) : t("today.unnamed"),
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

/** How long, in the coarsest honest unit — "seit 3 Tagen". */
export function sinceLabel(since: string | null, now: number, t: Translate): string | null {
  if (!since) return null;
  const at = Date.parse(since);
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t("today.since.now");
  if (minutes < 60) return counted(minutes, "today.since.minute", "today.since.minutes", t);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return counted(hours, "today.since.hour", "today.since.hours", t);
  const days = Math.floor(hours / 24);
  if (days < 14) return counted(days, "today.since.day", "today.since.days", t);
  const weeks = Math.floor(days / 7);
  if (days < 60) return counted(weeks, "today.since.week", "today.since.weeks", t);
  return counted(Math.floor(days / 30), "today.since.month", "today.since.months", t);
}

/**
 * One entry as one sentence: its subject, its reason, and since when.
 *
 * A reason this build does not know is not swallowed and not called
 * "unbekannt": the subject is still named, and the engine's own value follows,
 * marked as a machine value.
 */
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
      lead: subject ? t("today.reason.other", { subject }) : t("today.reason.otherWithoutSubject"),
      machine: item.reason,
      since,
    };
  }

  switch (item.reason) {
    case "failing": {
      const cause = item.cause_class ? CAUSE_KEYS[item.cause_class] : undefined;
      let lead = t(
        (item.counts.failures ?? 0) > 1 ? "today.reason.failingCount" : "today.reason.failing",
        { subject, count: item.counts.failures ?? 1 },
      );
      if (cause) lead = t("today.withCause", { sentence: lead, cause: t(cause) });
      if (item.counts.patches)
        lead = t("today.withPatches", {
          sentence: lead,
          patches: counted(item.counts.patches, "today.patches.one", "today.patches.many", t),
        });
      // A cause class the build has no word for is the engine's value, marked.
      const machine = item.cause_class && !cause ? item.cause_class : null;
      return { lead, machine, since };
    }
    case "patch_proposed":
      return {
        lead: t((item.counts.patches ?? 1) > 1 ? "today.reason.patch_proposedCount" : reasonKey, {
          subject,
          count: item.counts.patches ?? 1,
        }),
        machine: null,
        since,
      };
    case "skills_proposed":
      return {
        lead: t((item.counts.skills ?? 1) > 1 ? "today.reason.skills_proposedCount" : reasonKey, {
          count: item.counts.skills ?? 1,
        }),
        machine: null,
        since,
      };
    case "scheduler_stale": {
      const heartbeat = HEARTBEAT_KEYS[item.kind];
      return heartbeat
        ? { lead: t(reasonKey, { heartbeat: t(heartbeat) }), machine: null, since }
        : { lead: t("today.reason.scheduler_staleOther"), machine: item.kind, since };
    }
    case "risk_critical": {
      const signal = SIGNAL_KEYS[item.kind];
      return signal
        ? { lead: t(reasonKey, { signal: t(signal) }), machine: null, since }
        : { lead: t("today.reason.risk_criticalOther"), machine: item.kind, since };
    }
    default:
      return { lead: t(reasonKey, { subject }), machine: null, since };
  }
}

/** The sentence as plain text — for tests and for accessible names. */
export function sentenceText(sentence: AttentionSentence): string {
  const machine = sentence.machine ? ` (${sentence.machine})` : "";
  const since = sentence.since ? ` — ${sentence.since}` : "";
  return `${sentence.lead}${machine}${since}.`;
}

// --------------------------------------------------------------------------
// The actions.

/** The one primary action, and at most one secondary link. */
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
      return "today.action.review";
    case "answer":
      return "today.action.answer";
    case "reauth":
      return "today.action.reauth";
    case "renew":
      return "today.action.renew";
    case "open_runs":
      return "today.action.openRuns";
    case "chat":
      return "today.action.chat";
    default:
      if (item.reason === "secret_prepared") return "today.action.openSettings";
      if (item.reason === "budget_critical") return "today.action.openUsage";
      if (item.subject?.kind === "connector") return "today.action.openConnector";
      return "today.action.openOperations";
  }
}

const SOURCE_KEYS = {
  conversations: "today.source.conversations",
  schedules: "today.source.schedules",
  freshness: "today.source.freshness",
  failures: "today.source.failures",
  patches: "today.source.patches",
  connectors: "today.source.connectors",
  connections: "today.source.connections",
  secret_approvals: "today.source.secret_approvals",
  skills: "today.source.skills",
  budget: "today.source.budget",
  risk: "today.source.risk",
} as const satisfies Record<AttentionSource, TranslationKey>;

export function sourceLabel(source: AttentionSource, t: Translate): string {
  return t(SOURCE_KEYS[source]);
}

const HEALTH_KEYS = {
  healthy: "today.health.healthy",
  limited: "today.health.limited",
  critical: "today.health.critical",
  unknown: "today.health.unknown",
} as const satisfies Record<HealthState, TranslationKey>;

/**
 * The one status line of the calm state: health · next scheduled run.
 * Null for a reader without `stats:read`, to whom the engine sends no status.
 */
export function statusLine(
  status: Attention["status"],
  t: Translate,
  dateTime: (value: string) => string,
): string | null {
  if (!status) return null;
  const health = t(HEALTH_KEYS[status.health_state] ?? "today.health.unknown");
  const next = status.next_run_at
    ? t("today.status.nextRun", { when: dateTime(status.next_run_at) })
    : t("today.status.noRun");
  return `${health} · ${next}`;
}

/** Which kind of review an entry's sheet holds. */
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
