import type { TranslationKey } from "./i18n";
import { humanize } from "./i18n";

const STATUS_KEYS: Partial<Record<string, TranslationKey>> = {
  active: "status.active",
  awaiting_input: "status.awaitingInput",
  committed: "status.committed",
  abandoned: "status.abandoned",
  pending: "status.pending",
  running: "status.running",
  completed: "status.completed",
  failed: "status.failed",
  cancelled: "status.cancelled",
  approved: "status.approved",
  rejected: "status.rejected",
};

export function statusLabel(translate: (key: TranslationKey) => string, value: string): string {
  const key = STATUS_KEYS[value.toLowerCase()];
  return key ? translate(key) : humanize(value);
}
