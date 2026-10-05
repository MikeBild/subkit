import type { TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

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

const INBOX_WORKSPACE = "_cli";
export const INBOX_TARGET = { workspace: INBOX_WORKSPACE, channel: "_inbox" } as const;

export const CHANNEL_PLATFORMS = ["slack", "google_chat", "webhook"] as const;

export const SEVERITIES = ["debug", "info", "warn", "error", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
const SEEDED_INBOX_RULE = "sk CLI inbox (default)";

const PLATFORM_KEYS: Readonly<Record<string, TranslationKey>> = {
  sk_cli: "notifications.platform.inbox",
  slack: "notifications.platform.slack",
  google_chat: "notifications.platform.googleChat",
  webhook: "notifications.platform.webhook",
};

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

export const EVENT_KEYS: Readonly<Record<string, TranslationKey>> = {
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

export function eventPatternLabels(pattern: string, t: Translate): CatalogLabel[] {
  const parts = pattern
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.includes("*"))
    return [{ text: t("notifications.events.all"), machine: false }];
  return parts.map((part) => eventPartLabel(part, t));
}

export function workflowPatternLabel(pattern: string, t: Translate): CatalogLabel {
  const trimmed = pattern.trim();
  if (trimmed === "" || trimmed === "*")
    return { text: t("notifications.workflows.all"), machine: false };
  return { text: trimmed, machine: true };
}

function isInboxRule(rule: NotificationRuleLike): boolean {
  return rule.target_workspace_id === INBOX_WORKSPACE;
}

export function ruleNameLabel(rule: NotificationRuleLike, t: Translate): string {
  return isInboxRule(rule) && rule.name === SEEDED_INBOX_RULE
    ? t("notifications.rule.defaultInbox")
    : rule.name;
}

export type RuleTarget =
  | { kind: "inbox" }
  | { kind: "channel"; channel: NotificationChannelLike }
  | { kind: "pending" };

export function ruleTarget(
  rule: NotificationRuleLike,
  channels: readonly NotificationChannelLike[],
): RuleTarget {
  if (isInboxRule(rule)) return { kind: "inbox" };
  const channel = channels.find((candidate) => delivers(rule, candidate));
  return channel ? { kind: "channel", channel } : { kind: "pending" };
}

function delivers(rule: NotificationRuleLike, channel: NotificationChannelLike): boolean {
  return (
    channel.channel_id === rule.target_channel_id &&
    (rule.target_workspace_id === undefined ||
      channel.workspace_id === undefined ||
      channel.workspace_id === rule.target_workspace_id)
  );
}

export function rulesUsing(
  channel: NotificationChannelLike,
  rules: readonly NotificationRuleLike[],
): number {
  return rules.filter((rule) => delivers(rule, channel)).length;
}

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
