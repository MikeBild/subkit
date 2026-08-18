import type { TranslationKey } from "./i18n";

// Every state the engine can persist, in one map.
//
// This map used to cover the conversation and execution vocabularies and
// nothing else, so the whole catalogue vocabulary — a workflow's lifecycle, a
// connector's health, a knowledge source's ingestion state, a file's scan state
// — fell through to the "unknown" placeholder. It showed up twice on every one
// of those pages: once in the state column and once in the filter dropdown that
// is built from the same values, which is why a person filtering by lifecycle
// was offered a list of identical words.
//
// The connector health words are REUSED rather than duplicated: a connector's
// health cell and a status filter that resolves the same value must not be able
// to drift into two different translations of one fact.
const STATUS_KEYS: Partial<Record<string, TranslationKey>> = {
  // Conversations
  active: "status.active",
  awaiting_input: "status.awaitingInput",
  committed: "status.committed",
  abandoned: "status.abandoned",
  // Executions
  pending: "status.pending",
  queued: "status.queued",
  running: "status.running",
  completed: "status.completed",
  succeeded: "status.succeeded",
  failed: "status.failed",
  cancelled: "status.cancelled",
  aborted: "status.aborted",
  timed_out: "status.timedOut",
  // Decisions
  approved: "status.approved",
  rejected: "status.rejected",
  proposed: "status.proposed",
  applied: "status.applied",
  superseded: "status.superseded",
  // Workflow and skill lifecycle
  draft: "status.draft",
  archived: "status.archived",
  // Connectors and anything else that is switched on or off
  enabled: "status.enabled",
  disabled: "status.disabled",
  inactive: "status.inactive",
  // Connector health — shared with the connector list's own cell
  ok: "connectors.healthState.ok",
  degraded: "connectors.healthState.degraded",
  needs_update: "connectors.healthState.needsUpdate",
  needs_reauth: "connectors.healthState.needsReauth",
  needs_attention: "connectors.healthState.needsAttention",
  // Knowledge sources
  processing: "status.processing",
  error: "status.error",
  // Files
  uploading: "status.uploading",
  scanning: "status.scanning",
  ready: "status.ready",
  expired: "status.expired",
  // Notification severity — the inbox renders it as a state word, and these
  // four were the last vocabulary still falling through to the placeholder.
  debug: "status.debug",
  info: "status.info",
  warn: "status.warn",
  critical: "status.critical",
  // File scan verdicts — the same column an operator reads as a state
  clean: "status.clean",
  infected: "status.infected",
  noop: "status.notScanned",
  timeout: "status.timedOut",
};

export function statusLabel(translate: (key: TranslationKey) => string, value: string): string {
  const key = STATUS_KEYS[value.toLowerCase()];
  return translate(key ?? "status.unknown");
}
