import type { TranslationKey } from "./i18n";

const STATUS_KEYS: Partial<Record<string, TranslationKey>> = {
  active: "status.active",
  awaiting_input: "status.awaitingInput",
  committed: "status.committed",
  abandoned: "status.abandoned",
  pending: "status.pending",
  queued: "status.queued",
  running: "status.running",
  completed: "status.completed",
  succeeded: "status.succeeded",
  failed: "status.failed",
  cancelled: "status.cancelled",
  aborted: "status.aborted",
  timed_out: "status.timedOut",
  approved: "status.approved",
  rejected: "status.rejected",
  proposed: "status.proposed",
  applied: "status.applied",
  superseded: "status.superseded",
};

export function statusLabel(translate: (key: TranslationKey) => string, value: string): string {
  const key = STATUS_KEYS[value.toLowerCase()];
  return translate(key ?? "status.unknown");
}
