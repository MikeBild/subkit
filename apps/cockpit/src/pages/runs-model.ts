import type { ReactNode } from "react";
import type { components } from "@/api/schema";
import { auditHref, instantParam, RUNS_FILTER_PARAMS, uuidParam } from "@/app/links";
import { causeClassLabel } from "@/lib/cause-class";
import { LOCALE_TAGS, type Locale, type PluralKey, type TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";
import { shortIdentifier } from "@/pages/audit-model";

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
  ui: "runs.source.ui",
};

export const REQUEST_SOURCES: readonly string[] = Object.keys(REQUEST_SOURCE_KEYS);

export function isKnownRequestSource(source: string): boolean {
  return source in REQUEST_SOURCE_KEYS;
}

export interface RunsFilter {
  status: string;
  q: string;
  source: string;
  workflowId: string | null;
  startedFrom: string | null;
  startedTo: string | null;
}

export function filterFromUrl(search: string): RunsFilter {
  const params = new URLSearchParams(search);
  const status = params.get(RUNS_FILTER_PARAMS.status) ?? "";
  const source = params.get(RUNS_FILTER_PARAMS.source) ?? "";
  return {
    status: RUN_STATUSES.includes(status as (typeof RUN_STATUSES)[number]) ? status : "all",
    q: (params.get(RUNS_FILTER_PARAMS.q) ?? "").slice(0, 200),
    source: isKnownRequestSource(source) ? source : "all",
    workflowId: uuidParam(params, RUNS_FILTER_PARAMS.workflowId),
    startedFrom: instantParam(params, RUNS_FILTER_PARAMS.startedFrom),
    startedTo: instantParam(params, RUNS_FILTER_PARAMS.startedTo),
  };
}

export function executionsQuery(
  filter: RunsFilter,
  page: { limit: number; offset: number },
): URLSearchParams {
  const params = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset) });
  if (filter.status !== "all") params.set("status", filter.status);
  if (filter.source !== "all") params.set("request_source", filter.source);
  if (filter.workflowId) params.set("workflow_id", filter.workflowId);
  if (filter.startedFrom) params.set("started_from", filter.startedFrom);
  if (filter.startedTo) params.set("started_to", filter.startedTo);
  const needle = filter.q.trim();
  if (needle) params.set("q", needle);
  return params;
}

export const RUNS_FILTER_KEYS: readonly string[] = Object.values(RUNS_FILTER_PARAMS);

export function runsFilterSearch(
  search: string,
  filter: Pick<RunsFilter, "status" | "source" | "q">,
): string {
  const params = new URLSearchParams(search);
  const written: [string, string][] = [
    [RUNS_FILTER_PARAMS.status, filter.status === "all" ? "" : filter.status],
    [RUNS_FILTER_PARAMS.source, filter.source === "all" ? "" : filter.source],
    [RUNS_FILTER_PARAMS.q, filter.q.trim()],
  ];
  for (const [key, value] of written) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function failedStatusesFor(status: string): string | null {
  if (status === "all") return [...FAILED_RUN_STATUSES].join(",");
  return FAILED_RUN_STATUSES.has(status) ? status : null;
}

export function runOverlayFromUrl(search: string): { list: boolean; runId: string | null } {
  const params = new URLSearchParams(search);
  const raw = params.get("run")?.trim() ?? "";
  return {
    list: params.get("runs") === "all",
    runId: raw && raw.length <= 128 && /^[\w.:-]+$/.test(raw) ? raw : null,
  };
}

export function runOverlaySearch(
  search: string,
  next: { list: boolean; runId: string | null },
): string {
  const params = new URLSearchParams(search);
  if (next.list) params.set("runs", "all");
  else {
    params.delete("runs");
    for (const key of RUNS_FILTER_KEYS) params.delete(key);
  }
  if (next.runId) params.set("run", next.runId);
  else params.delete("run");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function isExecutionRecord(value: unknown): value is Execution {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.status === "string";
}

export function previewText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const trimmed = text?.trim() ?? "";
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return null;
  return text;
}

export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export type TranslatePlural = (
  key: PluralKey,
  count: number,
  values?: Record<string, string | number>,
) => string;

export function runsSummaryText(total: number, failed: number | null, tn: TranslatePlural): string {
  return failed === null ? tn("runs.summaryTotal", total) : tn("runs.summary", total, { failed });
}

export type RunFact = [label: string, value: ReactNode, full?: string];

function identifierFact(label: string, value: string): RunFact {
  const shown = shortIdentifier(value);
  return shown === value ? [label, value] : [label, shown, value];
}

export function runAuthorityFacts(
  run: Pick<Execution, "execution_authority_id" | "workflow_version_id" | "hold_writes">,
  t: Translate,
): RunFact[] {
  return [
    ...(run.hold_writes ? [[t("runs.boundary"), t("runs.preparationDescription")] as RunFact] : []),
    run.execution_authority_id != null
      ? identifierFact(t("authority.usedByRun"), run.execution_authority_id)
      : ([t("authority.usedByRun"), t("authority.noStoredBinding")] as RunFact),
    ...(run.workflow_version_id
      ? [identifierFact(t("authority.version"), run.workflow_version_id)]
      : []),
  ];
}

const VERIFICATION_KEYS = {
  api_key: "runs.caller.method.api_key",
  browser_session: "runs.caller.method.browser_session",
  mcp_oauth: "runs.caller.method.mcp_oauth",
  token_exchange: "runs.caller.method.token_exchange",
} as const satisfies Record<string, TranslationKey>;

export type RunCaller = {
  who: string;
  channel: string | null;
  state: "verified" | "automatic";
  why: RunFact[];
};

export function runCaller(
  run: Pick<
    Execution,
    "caller" | "request_source" | "execution_authority_id" | "workflow_version_id" | "hold_writes"
  >,
  directory: ReadonlyMap<string, string>,
  t: Translate,
): RunCaller {
  const { caller } = run;
  const channel = requestSourceLabel(run.request_source, t).text;
  const verified = caller.verified_by !== null;
  const kindLabel = t(
    caller.kind === "system_account" ? "runs.caller.systemAccount" : "runs.caller.person",
  );
  const named = caller.kind === "user" || caller.kind === "system_account";
  const who = named
    ? ((caller.principal_id ? directory.get(caller.principal_id) : undefined) ?? kindLabel)
    : channel;
  return {
    who,
    channel: named ? channel : null,
    state: verified ? "verified" : "automatic",
    why: [
      [
        t("runs.caller.verifiedBy"),
        t(caller.verified_by ? VERIFICATION_KEYS[caller.verified_by] : "runs.caller.method.none"),
      ],
      ...(caller.provider && verified
        ? [[t("runs.caller.provider"), caller.provider] as RunFact]
        : []),
      ...runAuthorityFacts(run, t),
      ...(caller.origin_execution_id
        ? [identifierFact(t("runs.caller.origin"), caller.origin_execution_id)]
        : []),
    ],
  };
}

export function runName(run: Execution, t: Translate): string {
  if (run.workflow_name?.trim()) return run.workflow_name;
  return t(SOURCE_KIND_KEYS[run.source_kind] ?? "runs.sourceKind.saved");
}

export function requestSourceLabel(source: string, t: Translate): CatalogLabel {
  return catalogLabel(source, REQUEST_SOURCE_KEYS[source], t);
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
  const totalSeconds = Math.round(ms / 1_000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

export function runDurationMs(run: Pick<Execution, "started_at" | "finished_at">): number | null {
  if (!run.started_at || !run.finished_at) return null;
  const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function runCostFacts(cost: unknown, t: Translate, locale: Locale): Array<[string, string]> {
  if (!cost || typeof cost !== "object") return [];
  const llm = (cost as { llm?: Record<string, unknown> }).llm;
  const external = (cost as { external?: Record<string, unknown> }).external;
  const calls = typeof llm?.calls === "number" ? llm.calls : 0;
  const out: Array<[string, string]> = [];
  const number = new Intl.NumberFormat(LOCALE_TAGS[locale]);

  if (calls > 0) {
    const weighted = typeof llm?.weighted_tokens === "number" ? llm.weighted_tokens : 0;
    out.push([t("runs.cost.tokens"), number.format(weighted)]);
    out.push([t("runs.cost.calls"), number.format(calls)]);
    const cachePct = typeof llm?.cache_read_pct === "number" ? llm.cache_read_pct : null;
    if (cachePct !== null) {
      out.push([
        t("runs.cost.cacheRead"),
        new Intl.NumberFormat(LOCALE_TAGS[locale], {
          style: "percent",
          maximumFractionDigits: 0,
        }).format(cachePct / 100),
      ]);
    }
  }

  const usd = typeof external?.cost_usd === "number" ? external.cost_usd : 0;
  if (usd > 0) {
    out.push([
      t("runs.cost.external"),
      new Intl.NumberFormat(LOCALE_TAGS[locale], {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
      }).format(usd),
    ]);
  }
  return out;
}

export type ExecutionOutcome = components["schemas"]["ExecutionOutcome"];

export interface OutcomeSentence {
  lead: string;
  cause: CatalogLabel | null;
  tail: string;
  plain: string;
}

const CAUSE_SLOT = "\u0000cause\u0000";

function splitAtCause(sentence: string, cause: CatalogLabel | null): OutcomeSentence {
  const at = sentence.indexOf(CAUSE_SLOT);
  if (at < 0 || !cause) return { lead: sentence, cause: null, tail: "", plain: sentence };
  const lead = sentence.slice(0, at);
  const tail = sentence.slice(at + CAUSE_SLOT.length);
  return { lead, cause, tail, plain: `${lead}${cause.text}${tail}` };
}

export function runOutcomeSentence(outcome: ExecutionOutcome, t: Translate): OutcomeSentence {
  const { steps } = outcome;
  const progress = (done: number) =>
    t(steps.total === 1 ? "runs.outcome.progress.one" : "runs.outcome.progress.other", {
      done,
      total: steps.total,
    });
  const cause =
    outcome.cause_class && outcome.cause_class !== "ok"
      ? causeClassLabel(outcome.cause_class, t)
      : null;
  switch (outcome.kind) {
    case "succeeded":
      return splitAtCause(
        t(
          outcome.output_contract === "violated"
            ? "runs.outcome.succeededContractViolated"
            : "runs.outcome.succeeded",
          { progress: progress(steps.succeeded) },
        ),
        null,
      );
    case "running":
      return splitAtCause(t("runs.outcome.running", { progress: progress(steps.succeeded) }), null);
    case "held":
      return splitAtCause(
        t("runs.outcome.held", { progress: progress(steps.succeeded), held: steps.held }),
        null,
      );
    case "partial":
      return splitAtCause(
        t(cause ? "runs.outcome.partialWithCause" : "runs.outcome.partial", {
          progress: progress(steps.succeeded),
          failed: steps.failed,
          cause: CAUSE_SLOT,
        }),
        cause,
      );
    default: {
      const step = outcome.failed_step?.step_key ?? null;
      const key: TranslationKey = step
        ? cause
          ? "runs.outcome.failedAtWithCause"
          : "runs.outcome.failedAt"
        : cause
          ? "runs.outcome.failedWithCause"
          : "runs.outcome.failed";
      return splitAtCause(
        t(key, { step: step ?? "", cause: CAUSE_SLOT, progress: progress(steps.succeeded) }),
        cause,
      );
    }
  }
}

type StepLike = {
  step_key: string;
  error?: unknown;
  output_preview?: unknown;
  result_preview: string | null;
  request_meta?: unknown;
};

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

export const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(["failed", "timed_out", "aborted"]);

export interface RunVerdict {
  label: string;
  tone: "critical" | "warning" | null;
}

export function runVerdict(
  status: string,
  outcome: ExecutionOutcome | null,
  t: Translate,
  statusWord: (status: string) => string,
): RunVerdict {
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

export function runStatusSentence(statusWord: string, t: Translate): OutcomeSentence {
  const plain = t("runs.outcome.statusOnly", { status: statusWord });
  return { lead: plain, cause: null, tail: "", plain };
}

const RERUN_REFUSALS: Partial<Record<string, TranslationKey>> = {
  workflow_version_unavailable: "runs.rerun.refused.versionUnavailable",
  workflow_archived: "runs.rerun.refused.archived",
  conflict: "runs.rerun.refused.notSaved",
  input_schema_violation: "runs.rerun.refused.input",
};

export function rerunFailureText(
  error: { code?: string | null; message?: string } | null | undefined,
  t: Translate,
): string {
  const code = error?.code ?? null;
  const known = code ? RERUN_REFUSALS[code] : undefined;
  if (known) return t(known);
  if (code?.startsWith("execution_authority")) return t("runs.rerun.refused.authority");
  const message = error?.message?.trim();
  return message
    ? `${t("runs.rerun.failed")} ${t("common.engineWording", { text: message })}`
    : t("runs.rerun.failed");
}

export function latestFailedRun<T extends { status: string }>(runs: readonly T[]): T | null {
  return runs.find((run) => FAILED_RUN_STATUSES.has(run.status)) ?? null;
}

export function stepConnectorId(step: StepLike | null): string | null {
  const meta = step?.request_meta;
  if (!meta || typeof meta !== "object") return null;
  const connector = (meta as { connector?: unknown }).connector;
  if (!connector || typeof connector !== "object") return null;
  const id = (connector as { connector_id?: unknown }).connector_id;
  return typeof id === "string" && id ? id : null;
}

export function stepGuidance(step: StepLike | null): string | null {
  const error = step?.error;
  if (!error || typeof error !== "object") return null;
  const guidance = (error as { guidance?: unknown }).guidance;
  return typeof guidance === "string" && guidance.trim() ? guidance : null;
}

export function runCauseLinks(
  runId: string,
  permissions: readonly string[],
  t: Translate,
): { label: string; href: string }[] {
  return permissions.includes("audit:read")
    ? [
        {
          label: t("runs.detail.audit"),
          href: auditHref({ resourceType: "execution", resourceId: runId }),
        },
      ]
    : [];
}
