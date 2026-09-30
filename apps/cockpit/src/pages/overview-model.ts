// The Übersicht — the operations bar over the one list of what needs the
// reader now — as pure functions.
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
import { causeClassKey } from "@/lib/cause-class";
import type { TranslationKey } from "@/lib/i18n";

export type Attention = components["schemas"]["AttentionV1"];
export type AttentionItem = components["schemas"]["AttentionItem"];
export type AttentionAction = components["schemas"]["AttentionAction"];
export type AttentionSource = keyof Attention["sources"];
export type HealthState = NonNullable<Attention["status"]>["health_state"];

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

// --------------------------------------------------------------------------
// Entries decided in this tab.
//
// Deciding takes an entry off the list at once. But deciding the last fix of
// a FAILING workflow does not end the entry: the workflow still fails, and the
// engine lists it again — the same id, now with a chat as its way forward. So
// an entry is hidden as the thing it WAS (reason, class, counts, primary
// action), and it is back the moment the engine lists it as anything else.

/** Hidden entry id → what the entry was when it was hidden. */
export type HiddenEntries = ReadonlyMap<string, string>;
export const NO_HIDDEN: HiddenEntries = new Map();

/** What an entry asks of the reader — the part a decision changes. */
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

/**
 * Keep only what the engine still lists unchanged. An entry that went away,
 * or came back as something else, is no longer ours to hide. Returns the same
 * map when nothing changed.
 */
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

// --------------------------------------------------------------------------
// What the page says.

export type OverviewView =
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

/**
 * What the page holds, top to bottom. The operations bar stands first in every
 * state — calm included, where it is the one place the installation's numbers
 * are read — and only for a reader who may read them. Below it: the list, the
 * calm sentence, or what could not be read; the one way to the history last.
 */
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

/**
 * The navigation badge: the number of entries, red when anything is stopped,
 * absent at zero and while the list cannot be read. A stale or guessed number
 * is worse than none.
 */
export function attentionBadge(
  attention: Attention | undefined,
  hidden: HiddenEntries = NO_HIDDEN,
): { count: number; stopped: boolean } | null {
  if (!attention) return null;
  const items = attentionEntries(attention.items, hidden);
  if (items.length === 0) return null;
  return { count: items.length, stopped: items.some((item) => item.class === "stopped") };
}

// --------------------------------------------------------------------------
// The sentence.

const REASON_KEYS = {
  awaiting_answer: "overview.reason.awaiting_answer",
  execution_authority_required: "overview.reason.execution_authority_required",
  execution_authority_unavailable: "overview.reason.execution_authority_unavailable",
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

/** The heartbeats the scheduler writes (operator/operational-overview.ts). */
const HEARTBEAT_KEYS: Record<string, TranslationKey> = {
  "self_healing.drift_scan": "overview.heartbeat.drift_scan",
  "connectors.reauth_scan": "overview.heartbeat.reauth_scan",
};

/** The critical signals the engine raises (operator/risk-signals.ts). */
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

/** How long, in the coarsest honest unit — "seit 3 Tagen". */
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
      // A webhook's refused calls said "its schedule waits", and people went
      // looking for a schedule the workflow does not have. Read as optional:
      // an engine that predates the field still gets the schedule sentence.
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
      // A cause class the build has no word for is the engine's value, marked.
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
      return "overview.action.review";
    case "answer":
      return "overview.action.answer";
    case "reauth":
      return "overview.action.reauth";
    case "renew":
      return "overview.action.renew";
    case "open_runs":
      return "overview.action.openRuns";
    case "chat":
      return "overview.action.chat";
    default:
      if (item.reason === "secret_prepared") return "overview.action.openSettings";
      if (item.reason === "budget_critical") return "overview.action.openUsage";
      if (item.subject?.kind === "connector") return "overview.action.openConnector";
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
  const health = t(HEALTH_KEYS[status.health_state] ?? "overview.health.unknown");
  const next = status.next_run_at
    ? t("overview.status.nextRun", { when: dateTime(status.next_run_at) })
    : t("overview.status.noRun");
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

/**
 * Whether this reader can see what a review sheet holds: a workflow's fixes
 * and held schedule need `workflow:read`, the skill proposals `skill:read`.
 * Any other entry has nothing to review in the sheet — it is acted on where
 * its primary action leads.
 */
export type ReviewAccess = "readable" | "not_permitted" | "nothing";

export function reviewAccess(target: ReviewTarget, permissions: readonly string[]): ReviewAccess {
  if (target.kind === "workflow")
    return permissions.includes("workflow:read") ? "readable" : "not_permitted";
  if (target.kind === "skills")
    return permissions.includes("skill:read") ? "readable" : "not_permitted";
  return "nothing";
}

/** The part of `window.history` the review sheet uses. */
export interface ReviewHistory {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url: string): void;
  replaceState(state: unknown, unused: string, url: string): void;
  back(): void;
}

const OPENED_HERE = "sk-attention-review";

/**
 * The sheet's address, kept honest with Back.
 *
 * Opening from the list pushes an entry marked as ours; closing that sheet
 * goes BACK, so the history is what it was before it opened and Back never
 * reopens a closed sheet (or a decided one, now empty). A sheet that arrived
 * by link has no entry of ours to leave: closing it replaces the address.
 */
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
