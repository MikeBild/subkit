import { auditReasonLabel } from "@/lib/audit-model";
import type { TranslationKey } from "@/lib/i18n";
import { historyKey } from "./tasks-model";
import { waitingReasonKey } from "./tasks-waiting";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const RUN_KEYS: Record<string, TranslationKey> = {
  "task_run.started": "tasks.history.run.started",
  "task_run.waiting": "tasks.history.run.waiting",
  "task_run.resumed": "tasks.history.run.resumed",
  "task_run.result_ready": "tasks.history.run.result_ready",
  "task_run.completed": "tasks.history.run.completed",
  "task_run.failed": "tasks.history.run.failed",
  "task_run.abort_requested": "tasks.history.run.abort_requested",
  "task_run.aborted": "tasks.history.run.aborted",
};

const REASON_FIELDS: Record<string, readonly string[]> = {
  "task_run.waiting": ["waiting_reason", "sleep_reason"],
  "task_run.failed": ["failure_code"],
  "task_run.aborted": ["reason_code"],
};

export interface HistoryEntry {
  action: string;
  reason?: string | null;
  details?: Readonly<Record<string, unknown>> | null;
}

function sleeps(entry: HistoryEntry): boolean {
  return entry.action === "task_run.waiting" && entry.details?.state === "sleeping";
}

export function historyLabelKey(entry: HistoryEntry): TranslationKey {
  if (sleeps(entry)) return "tasks.history.run.sleeping";
  return Object.hasOwn(RUN_KEYS, entry.action)
    ? (RUN_KEYS[entry.action] as TranslationKey)
    : historyKey(entry.action);
}

export function historyReason(entry: HistoryEntry, t: Translate): string | null {
  const fields = REASON_FIELDS[entry.action];
  if (!fields) return null;
  const details = entry.details ?? {};
  const code =
    fields.map((field) => details[field]).find((value) => typeof value === "string") ??
    (entry.action === "task_run.waiting" ? entry.reason : null);
  if (typeof code !== "string" || code === "") return null;
  const short = waitingReasonKey(code);
  if (short) return t(short);
  const label = auditReasonLabel(code, t);
  return label && !label.machine ? label.text : null;
}

export function historyTitle(entry: HistoryEntry, t: Translate): string {
  const label = t(historyLabelKey(entry));
  const reason = historyReason(entry, t);
  return reason ? t("tasks.history.withReason", { label, reason }) : label;
}
