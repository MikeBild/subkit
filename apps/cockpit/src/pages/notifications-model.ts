import type { TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

// What the notifications page says about a rule and a channel.
//
// It printed the engine's values: `*` as the events a rule forwards,
// `sk_cli` as a channel's name, the seeded rule's English name, and a
// delivery state that fell back to the red "ausgesetzt" badge for any phase
// it did not know. Each of those is read here into a sentence, and a value
// this build has no word for stays the engine's own, flagged as a machine
// value — never a guess, never the alarm.

export interface NotificationRuleLike {
  name: string;
  event_pattern: string;
  workflow_pattern: string;
  target_workspace_id?: string;
  target_channel_id: string;
}

export interface NotificationChannelLike {
  id: string;
  platform: string;
  workspace_id?: string;
  channel_id: string;
  circuit_state: string;
  circuit_open_until?: string | null;
  consecutive_failures?: number;
  active: boolean;
}

/** The reserved target the engine seeds for its local inbox (`_cli` / `_inbox`). */
const INBOX_WORKSPACE = "_cli";
/** The seeded rule's name, as `db/seed.ts` writes it. */
const SEEDED_INBOX_RULE = "sk CLI inbox (default)";

const PLATFORM_KEYS: Readonly<Record<string, TranslationKey>> = {
  sk_cli: "notifications.platform.inbox",
  slack: "notifications.platform.slack",
  google_chat: "notifications.platform.googleChat",
  webhook: "notifications.platform.webhook",
};

/** A channel's platform — `sk_cli` as the inbox it is. */
export function platformLabel(platform: string, t: Translate): CatalogLabel {
  return catalogLabel(platform, PLATFORM_KEYS[platform], t);
}

const EVENT_AREA_KEYS: Readonly<Record<string, TranslationKey>> = {
  execution: "notifications.eventArea.execution",
  approval: "notifications.eventArea.approval",
  workflow: "notifications.eventArea.workflow",
  connector: "notifications.eventArea.connector",
  schedule: "notifications.eventArea.schedule",
  patch: "notifications.eventArea.repair",
  patch_candidate: "notifications.eventArea.repair",
  self_healing: "notifications.eventArea.repair",
};

/** The engine's event catalogue (`webhooks/events/catalog.ts`), each by name. */
const EVENT_KEYS: Readonly<Record<string, TranslationKey>> = {
  "execution.succeeded": "notifications.event.execution.succeeded",
  "execution.failed": "notifications.event.execution.failed",
  "execution.refused": "notifications.event.execution.refused",
  "workflow.updated": "notifications.event.workflow.updated",
  "connector.oauth.refreshed": "notifications.event.connector.oauth.refreshed",
  "connector.oauth.callback_succeeded": "notifications.event.connector.oauth.callback_succeeded",
  "connector.oauth.callback_failed": "notifications.event.connector.oauth.callback_failed",
  "connector.auth_failed": "notifications.event.connector.auth_failed",
  "connector.health_changed": "notifications.event.connector.health_changed",
  "patch.proposed": "notifications.event.patch.proposed",
  "patch.applied": "notifications.event.patch.applied",
  "apikey.rotated": "notifications.event.apikey.rotated",
  "conversation.committed": "notifications.event.conversation.committed",
};

function eventPartLabel(part: string, t: Translate): CatalogLabel {
  const eventKey = EVENT_KEYS[part];
  if (eventKey) return { text: t(eventKey), machine: false };
  const area = /^([a-z_]+)\.\*$/.exec(part)?.[1];
  const areaKey = area ? EVENT_AREA_KEYS[area] : undefined;
  if (areaKey)
    return { text: t("notifications.events.area", { area: t(areaKey) }), machine: false };
  return { text: part, machine: true };
}

/**
 * Which events a rule forwards, one label per entry of its list.
 *
 * The engine reads a pattern as a comma-separated list (`matchGlob`), and the
 * seeded inbox rule is one: the page printed it raw, five event types in one
 * monospace run. Each entry is read on its own — a catalogued event by its
 * name, `execution.*` as the events about runs, anything else as the glob the
 * engine matches, marked as such. A list that holds `*` is every event.
 */
export function eventPatternLabels(pattern: string, t: Translate): CatalogLabel[] {
  const parts = pattern
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.includes("*"))
    return [{ text: t("notifications.events.all"), machine: false }];
  return parts.map((part) => eventPartLabel(part, t));
}

/** Which workflows a rule listens to. An empty pattern matches every one, as `*` does. */
export function workflowPatternLabel(pattern: string, t: Translate): CatalogLabel {
  const trimmed = pattern.trim();
  if (trimmed === "" || trimmed === "*")
    return { text: t("notifications.workflows.all"), machine: false };
  return { text: trimmed, machine: true };
}

function isInboxRule(rule: NotificationRuleLike): boolean {
  return rule.target_workspace_id === INBOX_WORKSPACE;
}

/** A rule's name. The seeded inbox rule has an English name the engine wrote; it gets ours. */
export function ruleNameLabel(rule: NotificationRuleLike, t: Translate): string {
  return isInboxRule(rule) && rule.name === SEEDED_INBOX_RULE
    ? t("notifications.rule.defaultInbox")
    : rule.name;
}

/**
 * Where a rule delivers.
 *
 * Channels are created lazily, on a rule's first delivery (`ensureChannel`),
 * so a rule without a channel row is not broken — it has not delivered yet.
 * The inbox needs no row to be named: its target is reserved.
 */
export type RuleTarget =
  | { kind: "inbox" }
  | { kind: "channel"; channel: NotificationChannelLike }
  | { kind: "pending" };

export function ruleTarget(
  rule: NotificationRuleLike,
  channels: readonly NotificationChannelLike[],
): RuleTarget {
  if (isInboxRule(rule)) return { kind: "inbox" };
  const channel = channels.find(
    (candidate) =>
      candidate.channel_id === rule.target_channel_id &&
      (rule.target_workspace_id === undefined ||
        candidate.workspace_id === undefined ||
        candidate.workspace_id === rule.target_workspace_id),
  );
  return channel ? { kind: "channel", channel } : { kind: "pending" };
}

/**
 * Whether a channel delivers, and if not, why and until when.
 *
 * - The local inbox is an insert, never circuit-broken: it always delivers.
 * - `open` with a cool-down still running is suspended — after repeated
 *   failures — and the engine retries by itself when the cool-down ends.
 * - `open` whose cool-down has passed, and `half_open`, are the retry: the
 *   next event is let through as a probe.
 * - A phase this build does not know is the engine's word, shown neutral.
 *   It used to fall back to the red badge, which reported an outage nobody
 *   had measured.
 */
export type DeliveryState =
  | { kind: "delivering" }
  | { kind: "suspended"; until: string | null; failures: number }
  | { kind: "retrying" }
  | { kind: "machine"; value: string };

export function deliveryState(channel: NotificationChannelLike, now: number): DeliveryState {
  if (channel.platform === "sk_cli") return { kind: "delivering" };
  const failures = channel.consecutive_failures ?? 0;
  const until = channel.circuit_open_until ?? null;
  const untilMs = until ? Date.parse(until) : Number.NaN;
  if (channel.circuit_state === "closed") return { kind: "delivering" };
  if (channel.circuit_state === "half_open") return { kind: "retrying" };
  if (channel.circuit_state === "open")
    return Number.isFinite(untilMs) && untilMs <= now
      ? { kind: "retrying" }
      : { kind: "suspended", until, failures };
  return { kind: "machine", value: channel.circuit_state };
}
