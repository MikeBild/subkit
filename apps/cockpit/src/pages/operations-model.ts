import type { components } from "@/api/schema";
import { absolute, connectorHref, connectorsHref, decisionsHref } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";

// What the system page owes a reader: is this installation healthy, and if
// not, why — each "why" one click from where it can be fixed.
//
// The page used to hold a scan button and a sentence saying its findings were
// on the overview, while the overview's red health tile linked here. A loop
// with no cause at either end. The engine now names the causes (contract 2.3:
// `health.causes[]`, a drilldown on every component and on every freshness
// source); this file decides which of them are a problem, and says nothing
// when nothing is.

export type OperationalOverview = components["schemas"]["OperationalOverviewV1"];
type Health = OperationalOverview["core"]["health"];
type HealthComponent = Health["components"][number];
type Freshness = OperationalOverview["core"]["data_freshness"];
type FreshnessSource = Freshness["sources"][number];

export type AttentionTone = "critical" | "warning";

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  text: string;
  /**
   * Free text the engine wrote (a failing group's cause, a connector's health
   * reason), shown on its own line and marked as the engine's — never folded
   * into `text`, which is always the cockpit's own sentence.
   */
  engineWording: string | null;
  /** A browser address, or null when there is nowhere to go from here. */
  href: string | null;
  actionLabel: string | null;
}

type Cause = Health["causes"][number];

const CAUSE_TEXT: Record<Cause["reason"], TranslationKey> = {
  held_for_review: "operations.cause.held_for_review",
  failing: "operations.cause.failing",
  needs_reauth: "operations.cause.needs_reauth",
  needs_update: "operations.cause.needs_update",
  degraded: "operations.cause.degraded",
  unhealthy: "operations.cause.unhealthy",
};

const UNNAMED_SUBJECT: Record<Cause["subject"]["kind"], TranslationKey> = {
  workflow: "operations.cause.unnamed.workflow",
  connector: "operations.cause.unnamed.connector",
};

/**
 * One engine cause as the cockpit's own sentence, and the way to where it is
 * fixed.
 *
 * The engine's `label` is an English sentence ("Monatsreport: automatic runs
 * held for review"); rendered verbatim it sat inside a German page as if the
 * cockpit had written it. The sentence is composed here from what the cause is
 * about and why it counts; the one piece nobody can translate — the engine's
 * free-text detail — travels beside it, marked as the engine's.
 *
 * The way in is built here too, from the subject, by the same builders every
 * other link uses: the blocked or failing bucket of the queue for a workflow,
 * the connector itself for a connector.
 */
export function causeAttention(cause: Cause, format: AttentionFormat): AttentionItem {
  const name = cause.subject.name?.trim() || format.t(UNNAMED_SUBJECT[cause.subject.kind]);
  const path =
    cause.subject.kind === "connector"
      ? cause.subject.id
        ? connectorHref(cause.subject.id)
        : connectorsHref({ health: "not_ok" })
      : decisionsHref({ bucket: cause.reason === "held_for_review" ? "blocked" : "failing" });
  return {
    id: `cause:${cause.kind}:${cause.id}`,
    tone: cause.subject.kind === "connector" ? "warning" : "critical",
    text: format.t(CAUSE_TEXT[cause.reason], { name }),
    engineWording: cause.detail?.trim() || null,
    href: absolute(path),
    actionLabel: format.t(drilldownLabelKey(cause.drilldown.label_id)),
  };
}

export interface AttentionFormat {
  t: (key: TranslationKey, values?: Record<string, string>) => string;
  /** A timestamp as the reader's locale writes it. */
  dateTime: (iso: string) => string;
  /** A component's raw value in its own unit (`ratio`, `count`). */
  value: (raw: number, unit: string) => string;
}

const COMPONENT_LABEL: Record<string, TranslationKey> = {
  "decisions.blocked": "operations.component.blocked",
  "executions.success_ratio": "operational.metric.executionSuccess",
  "connectors.healthy_ratio": "operational.metric.connectorHealth",
};

const SOURCE_LABEL: Record<string, TranslationKey> = {
  "self_healing.drift_scan": "operations.freshness.source.drift_scan",
  "connectors.reauth_scan": "operations.freshness.source.reauth_scan",
};

/**
 * The engine names each drilldown by a `label_id`; these are the words for it.
 * An id this build does not know still gets a way in, under a plain "Show".
 */
const DRILLDOWN_LABEL: Record<string, TranslationKey> = {
  "operational.open_blocked": "operations.link.open_blocked",
  "operational.open_failing": "operations.link.open_failing",
  "operational.open_runs": "operations.link.open_runs",
  "operational.open_connectors": "operations.link.open_connectors",
  "operational.open_connector": "operations.link.open_connector",
  "operational.open_scans": "operations.link.open_scans",
};

export function componentLabelKey(id: string): TranslationKey | null {
  return COMPONENT_LABEL[id] ?? null;
}

export function freshnessSourceLabelKey(id: string): TranslationKey | null {
  return SOURCE_LABEL[id] ?? null;
}

export function drilldownLabelKey(labelId: string): TranslationKey {
  return DRILLDOWN_LABEL[labelId] ?? "operations.link.fallback";
}

/** An engine drilldown as a browser address. Engine paths already carry `/cockpit`. */
export function drilldownHref(drilldown: { path: string } | null | undefined): string | null {
  const path = drilldown?.path?.trim();
  return path ? absolute(path) : null;
}

function componentName(component: HealthComponent, format: AttentionFormat): string {
  const key = componentLabelKey(component.id);
  return key ? format.t(key) : component.id;
}

function sourceName(source: FreshnessSource, format: AttentionFormat): string {
  const key = freshnessSourceLabelKey(source.id);
  return key ? format.t(key) : source.id;
}

/** Below full marks, or unreadable: a component that pulls the score down. */
function componentHurts(component: HealthComponent): boolean {
  return component.normalized_score === null || component.normalized_score < 100;
}

/**
 * The problems, most blocking first — and an empty list when there are none.
 *
 * Empty is the healthy answer and the only one: an incomplete report, a state
 * the engine could not determine, a stale or never-run source are each a
 * problem of their own, never read as "all clear". Causes come first because
 * the engine already ordered them by what blocks most; a component is listed
 * only when the score is not healthy and the engine named no cause for it,
 * so the reader is never told the same thing twice.
 */
export function operationsAttention(
  overview: OperationalOverview,
  format: AttentionFormat,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const health = overview.core.health;
  if (overview.snapshot_state !== "ready") {
    items.push({
      id: "snapshot",
      tone: "warning",
      engineWording: null,
      text: format.t("operations.attention.partial"),
      href: null,
      actionLabel: null,
    });
  }
  for (const cause of health.causes) items.push(causeAttention(cause, format));
  if (health.state === "unknown") {
    const missing = health.components.find((component) => component.normalized_score === null);
    items.push({
      id: "health:undetermined",
      tone: "warning",
      engineWording: null,
      text: format.t("operations.attention.undetermined"),
      href: missing ? drilldownHref(missing.drilldown) : null,
      actionLabel: missing ? format.t(drilldownLabelKey(missing.drilldown.label_id)) : null,
    });
  } else if (health.state !== "healthy" && health.causes.length === 0) {
    for (const component of health.components.filter(componentHurts)) {
      if (component.raw_value === null) continue;
      items.push({
        id: `component:${component.id}`,
        engineWording: null,
        tone: health.state === "critical" ? "critical" : "warning",
        text: format.t("operations.attention.component", {
          component: componentName(component, format),
          value: format.value(component.raw_value, component.unit),
        }),
        href: drilldownHref(component.drilldown),
        actionLabel: format.t(drilldownLabelKey(component.drilldown.label_id)),
      });
    }
  }
  for (const source of overview.core.data_freshness.sources) {
    if (source.state !== "stale" && source.state !== "missing") continue;
    items.push({
      id: `freshness:${source.id}`,
      engineWording: null,
      tone: source.state === "stale" ? "critical" : "warning",
      text:
        source.state === "stale" && source.updated_at
          ? format.t("operations.attention.stale", {
              source: sourceName(source, format),
              date: format.dateTime(source.updated_at),
            })
          : format.t("operations.attention.missing", { source: sourceName(source, format) }),
      href: drilldownHref(source.drilldown),
      actionLabel: format.t(drilldownLabelKey(source.drilldown.label_id)),
    });
  }
  return items;
}

/**
 * The line under "Zustand dieser Installation".
 *
 * It printed "Zustand: Unbekannt" — the word §2 bans, as a state. A state the
 * engine could not work out is said as that, with the reason: the same
 * sentence the attention block raises for it, so the page says it one way.
 */
export function healthStateLine(
  state: Health["state"],
  t: (key: TranslationKey, values?: Record<string, string>) => string,
): string {
  if (state === "unknown") return t("operations.attention.undetermined");
  return t("operations.health.state", {
    state: t(`operational.health.${state}` as TranslationKey),
  });
}

/**
 * What the drift scan's toast says, and whether it offers the way to the queue.
 *
 * The toast said "completed" and nothing else, so a scan that proposed three
 * repairs and a scan that found nothing read the same. The response carries
 * `candidates_created`; a count above zero is decisions waiting, and the toast
 * leads there.
 */
export function scanOutcome(response: { candidates_created?: unknown } | null | undefined): {
  key: TranslationKey;
  count: number;
  offerDecisions: boolean;
} {
  const raw = response?.candidates_created;
  // No count is not zero: an answer without it says only that the scan ran.
  if (typeof raw !== "number" || !Number.isFinite(raw))
    return { key: "operations.scanStarted", count: 0, offerDecisions: false };
  const count = Math.max(0, Math.floor(raw));
  return count > 0
    ? { key: "operations.scanFound", count, offerDecisions: true }
    : { key: "operations.scanFoundNone", count: 0, offerDecisions: false };
}
