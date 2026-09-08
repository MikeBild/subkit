import type { components } from "@/api/schema";
import { LOCALE_TAGS, type Locale, type TranslationKey } from "@/lib/i18n";

type Execution = components["schemas"]["Execution"];

export const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
] as const;

export const SOURCE_KIND_KEYS: Record<Execution["source_kind"], TranslationKey> = {
  saved: "runs.sourceKind.saved",
  draft: "runs.sourceKind.draft",
  step: "runs.sourceKind.step",
};

const REQUEST_SOURCE_KEYS: Partial<Record<string, TranslationKey>> = {
  api: "runs.source.api",
  cli: "runs.source.cli",
  mcp: "runs.source.mcp",
  webhook: "runs.source.webhook",
  "tool-chain": "runs.source.toolChain",
  scheduler: "runs.source.scheduler",
  chat: "runs.source.chat",
};

export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/** Describe the execution's stored binding, never the workflow's current grant. */
export function runAuthorityFacts(
  run: Pick<Execution, "execution_authority_id" | "workflow_version_id" | "hold_writes">,
  t: Translate,
): Array<[string, string]> {
  return [
    ...(run.hold_writes
      ? [[t("runs.boundary"), t("runs.preparationDescription")] as [string, string]]
      : []),
    [t("authority.usedByRun"), run.execution_authority_id ?? t("authority.noStoredBinding")],
    ...(run.workflow_version_id
      ? [[t("authority.version"), run.workflow_version_id] as [string, string]]
      : []),
  ];
}

export function runName(run: Execution, t: Translate): string {
  if (run.workflow_name?.trim()) return run.workflow_name;
  return t(SOURCE_KIND_KEYS[run.source_kind] ?? "runs.sourceKind.saved");
}

export function requestSourceLabel(source: string, t: Translate): string {
  const key = REQUEST_SOURCE_KEYS[source];
  return key ? t(key) : t("common.unknown");
}

export function formatRunDuration(locale: Locale, ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < 60) {
    const seconds = new Intl.NumberFormat(LOCALE_TAGS[locale], {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(tenths);
    return `${seconds} s`;
  }
  // Round to whole seconds first so 119.6 s carries into "2m 0s", never "1m 60s".
  const totalSeconds = Math.round(ms / 1_000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/**
 * `/v1/executions` carries no `duration_ms`, so a run's length is the distance
 * between its own two timestamps. A run that has not finished has no duration
 * — that is `null`, not zero.
 */
export function runDurationMs(run: Pick<Execution, "started_at" | "finished_at">): number | null {
  if (!run.started_at || !run.finished_at) return null;
  const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
