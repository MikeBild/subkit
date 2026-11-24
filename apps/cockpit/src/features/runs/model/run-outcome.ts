import type { components } from "@cli-core/engine-api/openapi";
import { FAILED_RUN_STATUSES } from "./runs-filter";

export { stepWasHeld } from "@/lib/step-held";

type Execution = components["schemas"]["Execution"];
export type ExecutionOutcome = components["schemas"]["ExecutionOutcome"];
export type StepLike = {
  step_key: string;
  error?: unknown;
  output_preview?: unknown;
  result_preview: string | null;
  request_meta?: unknown;
};
export type PaginationLimit = "max_pages" | "max_items" | "max_bytes";
export type TruncatedStep = { step: string; limit: PaginationLimit | null };
const PAGINATION_LIMITS: ReadonlySet<unknown> = new Set(["max_pages", "max_items", "max_bytes"]);

function previewText(value: unknown): string | null {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const trimmed = text?.trim() ?? "";
  return !trimmed || trimmed === "null" || trimmed === "undefined" ? null : text;
}
export function runDurationMs(run: Pick<Execution, "started_at" | "finished_at">): number | null {
  const ms = Date.parse(String(run.finished_at)) - Date.parse(String(run.started_at));
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
export function stoppingStep<T extends StepLike>(
  steps: readonly T[],
  outcome: ExecutionOutcome | null,
): T | null {
  const key = outcome?.failed_step?.step_key;
  if (key) {
    const named = steps.find((step) => step.step_key === key);
    if (named) return named;
  }
  if (outcome && outcome.kind !== "failed" && outcome.kind !== "partial") return null;
  return steps.find((step) => previewText(step.error) !== null) ?? null;
}
export function payloadEvidence<T extends StepLike>(
  steps: readonly T[],
  runStatus: string,
  outcome: ExecutionOutcome | null = null,
): { text: string; stepKey: string | null; preview: boolean } | null {
  const last = [...steps]
    .reverse()
    .find((step) => previewText(step.output_preview ?? step.result_preview) !== null);
  if (!last) return null;
  const text = previewText(last.output_preview ?? last.result_preview);
  if (!text) return null;
  if (outcome?.kind === "held") return { text, stepKey: null, preview: true };
  const succeeded = outcome ? outcome.kind === "succeeded" : runStatus === "succeeded";
  return { text, stepKey: succeeded ? null : last.step_key, preview: false };
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown> | null)
    : null;
}
function knownLimit(value: unknown): PaginationLimit | null {
  return PAGINATION_LIMITS.has(value) ? (value as PaginationLimit) : null;
}
function truncationOf(step: StepLike): TruncatedStep | null {
  const pagination = record(record(step.request_meta)?.pagination);
  if (pagination?.truncated === true)
    return { step: step.step_key, limit: knownLimit(pagination.limit) };
  const warnings = record(step.output_preview)?.warnings;
  const warning = Array.isArray(warnings)
    ? warnings.map(record).find((entry) => entry?.code === "pagination_truncated")
    : undefined;
  return warning
    ? { step: step.step_key, limit: knownLimit(record(warning.details)?.limit) }
    : null;
}
export function truncatedSteps(steps: readonly StepLike[]): TruncatedStep[] {
  const seen = new Set<string>();
  return steps.flatMap((step) => {
    const truncation = truncationOf(step);
    if (!truncation || seen.has(truncation.step)) return [];
    seen.add(truncation.step);
    return [truncation];
  });
}
export function latestFailedRun<T extends { status: string }>(
  runs: readonly T[],
  failed: ReadonlySet<string>,
): T | null {
  return runs.find((run) => failed.has(run.status)) ?? null;
}
export function stepEffectKind(step: { request_meta?: unknown }): "read" | "write" | null {
  const meta = step.request_meta;
  if (!meta || typeof meta !== "object" || !("extras" in meta)) return null;
  const extras = meta.extras;
  return extras &&
    typeof extras === "object" &&
    "effect_kind" in extras &&
    (extras.effect_kind === "read" || extras.effect_kind === "write")
    ? extras.effect_kind
    : null;
}
export function runDisplayState(
  status: string,
  outcome: { kind?: string } | null | undefined,
  heldEffects = false,
): string {
  return outcome?.kind === "held" || heldEffects ? "held" : status;
}
export function runPermissionBasis(
  value: unknown,
): "builtin_admin" | "resource_grant" | "group" | "role" | "portal_token_allowlist" | null {
  switch (value) {
    case "builtin_admin":
    case "resource_grant":
    case "group":
    case "role":
    case "portal_token_allowlist":
      return value;
    default:
      return null;
  }
}
export function runPermissionEvidence(run: {
  permission_basis?: unknown;
  permission_phase?: unknown;
  permission_checked_at?: unknown;
}) {
  const basis = runPermissionBasis(run.permission_basis),
    phase = run.permission_phase,
    checkedAt = run.permission_checked_at;
  return basis &&
    (phase === "admission" || phase === "start") &&
    typeof checkedAt === "string" &&
    Number.isFinite(Date.parse(checkedAt))
    ? ({ basis, phase, checkedAt } as const)
    : null;
}

export function runVerdict(
  status: string,
  outcome: ExecutionOutcome | null,
  t: (key: "runs.state.partial" | "runs.state.held") => string,
  statusWord: (status: string) => string,
  truncated: readonly TruncatedStep[] = [],
): { label: string; tone: "critical" | "warning" | null; truncated?: true } {
  const finishedCleanly = outcome ? outcome.kind === "succeeded" : status === "succeeded";
  if (finishedCleanly && truncated.length > 0)
    return { label: t("runs.state.partial"), tone: "warning", truncated: true };
  if (outcome) {
    switch (outcome.kind) {
      case "held":
        return { label: t("runs.state.held"), tone: null };
      case "partial":
        return { label: t("runs.state.partial"), tone: "warning" };
      case "failed":
        return {
          label: statusWord(FAILED_RUN_STATUSES.has(status) ? status : "failed"),
          tone: "critical",
        };
      default:
        return { label: statusWord(status), tone: null };
    }
  }
  return {
    label: statusWord(status),
    tone: FAILED_RUN_STATUSES.has(status) ? "critical" : null,
  };
}

export function runTraceEvidence(
  run: unknown,
  mayReadAudit: boolean,
  traceHref: (id: string) => string,
): { id: string | null; href: string | null } {
  const raw = run && typeof run === "object" && "trace_id" in run ? run.trace_id : null;
  const id = typeof raw === "string" && raw.trim().length > 0 ? raw : null;
  return { id, href: id && mayReadAudit ? traceHref(id) : null };
}
