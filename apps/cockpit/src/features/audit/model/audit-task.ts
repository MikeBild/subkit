import { auditReasonLabel } from "@/features/audit/model/audit-entries";
import type { Translate, TranslationKey } from "@/lib/i18n";

type FormatDateTime = (value: string | Date) => string;
type Detail = string | number | boolean | null;

interface AuditTaskEntry {
  task_id?: string | null;
  task_run_id?: string | null;
  details?: Readonly<Record<string, Detail>> | null;
}

interface AuditTaskFact {
  label: string;
  value: string;
  tech?: boolean;
}

type DetailKind =
  | "start"
  | "state"
  | "reason"
  | "count"
  | "duration"
  | "instant"
  | "until"
  | "limit"
  | "mode"
  | "flag"
  | "id";

const DETAILS: readonly { field: string; label: TranslationKey; kind: DetailKind }[] = [
  { field: "trigger", label: "audit.task.start", kind: "start" },
  { field: "state", label: "audit.task.state", kind: "state" },
  { field: "previous_state", label: "audit.task.stateBefore", kind: "state" },
  { field: "waiting_reason", label: "audit.task.waitingBecause", kind: "reason" },
  { field: "paused_reason", label: "audit.task.pausedBecause", kind: "reason" },
  { field: "previous_paused_reason", label: "audit.task.wasPausedBecause", kind: "reason" },
  { field: "reason_code", label: "audit.column.reason", kind: "reason" },
  { field: "failure_code", label: "audit.task.cause", kind: "reason" },
  { field: "resume_reason", label: "audit.task.continuedAfter", kind: "reason" },
  { field: "turns_used", label: "audit.task.workSteps", kind: "count" },
  { field: "duration_ms", label: "audit.task.duration", kind: "duration" },
  { field: "scheduled_for", label: "audit.task.scheduledFor", kind: "instant" },
  { field: "deadline_at", label: "audit.task.finishBy", kind: "instant" },
  { field: "environment", label: "audit.task.runsIn", kind: "mode" },
  { field: "execution_environment", label: "audit.task.runsIn", kind: "mode" },
  { field: "valid_until", label: "audit.task.validUntil", kind: "until" },
  { field: "max_runs", label: "audit.task.runsAllowed", kind: "limit" },
  { field: "reserved_runs", label: "audit.task.runsUsed", kind: "count" },
  { field: "grant_invalidated", label: "audit.task.permissionEnded", kind: "flag" },
  { field: "task_grant_id", label: "audit.task.permissionId", kind: "id" },
  { field: "covering_authority_id", label: "audit.task.coveringApproval", kind: "id" },
];

const START_KEYS: Readonly<Record<string, TranslationKey>> = {
  manual: "audit.task.start.manual",
  once: "audit.task.start.once",
  cron: "audit.task.start.cron",
};

const STATE_KEYS: Readonly<Record<string, TranslationKey>> = {
  running: "audit.task.state.running",
  waiting: "audit.task.state.waiting",
  sleeping: "audit.task.state.sleeping",
  result_ready: "audit.task.state.result_ready",
  completed: "audit.task.state.completed",
  aborted: "audit.task.state.aborted",
  failed: "audit.task.state.failed",
  held: "audit.task.state.held",
  admitted: "audit.task.state.admitted",
};

const MODE_KEYS: Readonly<Record<string, TranslationKey>> = {
  dev: "audit.task.runsIn.dev",
  prod: "audit.task.runsIn.prod",
};

export function auditDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  const hours = (minutes - rest) / 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

function named(
  keys: Readonly<Record<string, TranslationKey>>,
  value: Detail,
  t: Translate,
): string | null {
  if (typeof value !== "string") return null;
  return Object.hasOwn(keys, value) ? t(keys[value] as TranslationKey) : value;
}

function shown(kind: DetailKind, value: Detail, t: Translate, dateTime: FormatDateTime) {
  switch (kind) {
    case "start":
      return named(START_KEYS, value, t);
    case "state":
      return named(STATE_KEYS, value, t);
    case "mode":
      return named(MODE_KEYS, value, t);
    case "reason":
      return typeof value === "string" ? (auditReasonLabel(value, t)?.text ?? null) : null;
    case "count":
      return typeof value === "number" ? String(value) : null;
    case "duration":
      return typeof value === "number" ? auditDuration(value) : null;
    case "instant":
      return typeof value === "string" ? dateTime(value) : null;
    case "until":
      if (value === null) return t("audit.task.untilRevoked");
      return typeof value === "string" ? dateTime(value) : null;
    case "limit":
      if (value === null) return t("audit.task.noLimit");
      return typeof value === "number" ? String(value) : null;
    case "flag":
      return typeof value === "boolean" ? t(value ? "common.yes" : "common.no") : null;
    case "id":
      return typeof value === "string" ? value : null;
  }
}

export function auditTaskFacts(
  entry: AuditTaskEntry,
  t: Translate,
  dateTime: FormatDateTime,
): AuditTaskFact[] {
  const details = entry.details ?? {};
  const facts: AuditTaskFact[] = [];
  if (entry.task_id)
    facts.push({ tech: true, label: t("audit.timeline.task"), value: entry.task_id });
  if (entry.task_run_id)
    facts.push({ tech: true, label: t("audit.timeline.taskRun"), value: entry.task_run_id });
  for (const detail of DETAILS) {
    if (!Object.hasOwn(details, detail.field)) continue;
    const value = shown(detail.kind, details[detail.field] as Detail, t, dateTime);
    if (value)
      facts.push({
        ...(detail.kind === "id" ? { tech: true } : {}),
        label: t(detail.label),
        value,
      });
  }
  return facts;
}
