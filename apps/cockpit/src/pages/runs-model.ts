import type { components } from "@cli-core/engine-api/openapi";
import type { ReactNode } from "react";
import { type ActorDirectory, actorDirectoryName } from "@/app/actor-directory-model";
import { auditHref } from "@/app/links";
import { statusTone } from "@/components/cockpit/patterns/status-badge";
import { causeClassLabel } from "@/lib/cause-class";
import { shortIdentifier } from "@/lib/core/identifier";
import {
  formatRelativeTime,
  LOCALE_TAGS,
  type Locale,
  type PluralKey,
  type TranslationKey,
} from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";
import {
  latestFailedRun as coreLatestFailedRun,
  payloadEvidence as corePayloadEvidence,
  runDisplayState as coreRunDisplayState,
  runDurationMs as coreRunDurationMs,
  runPermissionBasis as coreRunPermissionBasis,
  runPermissionEvidence as coreRunPermissionEvidence,
  runTraceEvidence as coreRunTraceEvidence,
  runVerdict as coreRunVerdict,
  stepEffectKind as coreStepEffectKind,
  stepWasHeld as coreStepWasHeld,
  stoppingStep as coreStoppingStep,
  truncatedSteps as coreTruncatedSteps,
} from "@/pages/core/run-outcome";
import { FAILED_RUN_STATUSES } from "@/pages/core/runs-filter";

export type { RunsFilter } from "@/pages/core/runs-filter";
export {
  executionsQuery,
  FAILED_RUN_STATUSES,
  failedStatusesFor,
  filterFromUrl,
  initialRunsFilter,
  isKnownRequestSource,
  REQUEST_SOURCES,
  RUN_STATUSES,
  RUNS_FILTER_KEYS,
  runOverlayFromUrl,
  runOverlaySearch,
  runsFilterSearch,
} from "@/pages/core/runs-filter";

type Execution = components["schemas"]["Execution"];

export const SOURCE_KIND_KEYS: Record<Execution["source_kind"], TranslationKey> = {
  saved: "runs.sourceKind.saved",
  draft: "runs.sourceKind.draft",
  step: "runs.sourceKind.step",
};

const REQUEST_SOURCE_KEYS: Partial<Record<string, TranslationKey>> = {
  api: "runs.source.api",
  cli: "runs.source.cli",
  mcp: "runs.source.mcp",
  webhook: "workflows.trigger.webhook",
  "tool-chain": "runs.source.toolChain",
  scheduler: "workflows.trigger.schedule",
  chat: "runs.source.chat",
  ui: "runs.source.ui",
  queue: "runs.source.queue",
};

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

type TranslatePlural = (
  key: PluralKey,
  count: number,
  values?: Record<string, string | number>,
) => string;

export function runsSummaryText(total: number, failed: number | null, tn: TranslatePlural): string {
  return failed === null ? tn("runs.summaryTotal", total) : tn("runs.summary", total, { failed });
}

export function runsWindowSummaryText(
  total: number,
  failed: number | null,
  tn: TranslatePlural,
): string {
  return failed === null
    ? tn("workflowRuns.weekTotal", total)
    : tn("workflowRuns.week", total, { failed });
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
  external_bearer: "runs.caller.method.external_bearer",
} as const satisfies Record<string, TranslationKey>;

type RunCaller = {
  who: string;
  channel: string | null;
  state: "verified" | "automatic" | "unknown";
  stateLabel: TranslationKey;
  why: RunFact[];
};

export function runCaller(
  run: Pick<
    Execution,
    "caller" | "request_source" | "execution_authority_id" | "workflow_version_id" | "hold_writes"
  >,
  directory: ActorDirectory,
  t: Translate,
): RunCaller {
  const { caller } = run;
  const channel = requestSourceLabel(run.request_source, t).text;
  const named = caller.kind === "user" || caller.kind === "system_account";
  const verified = named && caller.verified_by != null;
  const automatic = caller.kind === "engine";
  const kindLabel = t(
    caller.kind === "system_account" ? "runs.caller.systemAccount" : "runs.caller.person",
  );
  const who = named
    ? ((caller.principal_id
        ? actorDirectoryName(directory, caller.kind, caller.principal_id)
        : undefined) ?? kindLabel)
    : channel;
  return {
    who,
    channel: named ? channel : null,
    state: verified ? "verified" : automatic ? "automatic" : "unknown",
    stateLabel: verified
      ? "runs.caller.verified"
      : automatic
        ? "runs.caller.automatic"
        : "runs.caller.unknown",
    why: [
      [
        t("runs.caller.verifiedBy"),
        t(
          verified && caller.verified_by
            ? VERIFICATION_KEYS[caller.verified_by]
            : automatic
              ? "runs.caller.method.engine"
              : "runs.caller.method.none",
        ),
      ],
      ...(caller.provider && verified
        ? [[t("runs.caller.provider"), caller.provider] as RunFact]
        : []),
      ...(caller.product_id ? [[t("runs.caller.app"), caller.product_id] as RunFact] : []),
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
  return coreRunDurationMs(run);
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
  return coreStoppingStep(steps, outcome);
}

export function payloadEvidence<T extends StepLike>(
  steps: readonly T[],
  runStatus: string,
  outcome: ExecutionOutcome | null = null,
): { text: string; stepKey: string | null; preview: boolean } | null {
  return corePayloadEvidence(steps, runStatus, outcome);
}

interface RunVerdict {
  label: string;
  tone: "critical" | "warning" | null;
  truncated?: true;
}

type PaginationLimit = "max_pages" | "max_items" | "max_bytes";

interface TruncatedStep {
  step: string;
  limit: PaginationLimit | null;
}

export function truncatedSteps(steps: readonly StepLike[]): TruncatedStep[] {
  return coreTruncatedSteps(steps);
}

const TRUNCATION_KEYS: Record<PaginationLimit, TranslationKey> = {
  max_pages: "runs.outcome.truncated.pages",
  max_items: "runs.outcome.truncated.items",
  max_bytes: "runs.outcome.truncated.bytes",
};

export function runTruncationSentence(
  steps: readonly TruncatedStep[],
  t: Translate,
): OutcomeSentence {
  const plain = steps
    .map(({ step, limit }) =>
      t(limit ? TRUNCATION_KEYS[limit] : "runs.outcome.truncated.unknown", { step }),
    )
    .join(" ");
  return { lead: plain, cause: null, tail: "", plain };
}

export function runVerdict(
  status: string,
  outcome: ExecutionOutcome | null,
  t: Translate,
  statusWord: (status: string) => string,
  truncated: readonly TruncatedStep[] = [],
): RunVerdict {
  return coreRunVerdict(status, outcome, t, statusWord, truncated);
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
  return coreLatestFailedRun(runs, FAILED_RUN_STATUSES);
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

export interface StepCredentialSnapshot {
  connector_id: string;
  environment: "dev" | "prod";
  credential_generation: number | null;
  access_token_version: number | null;
  identity: { issuer: string; subject: string; source: string } | null;
}

export function stepCredentialSnapshots(step: {
  credential_snapshots?: unknown;
}): StepCredentialSnapshot[] {
  if (!Array.isArray(step.credential_snapshots)) return [];
  return step.credential_snapshots.filter((value): value is StepCredentialSnapshot => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.connector_id !== "string" ||
      !["dev", "prod"].includes(value.environment) ||
      ![value.credential_generation, value.access_token_version].every(
        (generation) =>
          generation === null ||
          (typeof generation === "number" && Number.isSafeInteger(generation) && generation > 0),
      )
    )
      return false;
    return (
      value.identity === null ||
      (typeof value.identity?.issuer === "string" &&
        typeof value.identity?.subject === "string" &&
        ["openid_claims", "token_endpoint"].includes(value.identity?.source))
    );
  });
}

export function stepEffectKind(step: { request_meta?: unknown }): "read" | "write" | null {
  return coreStepEffectKind(step);
}

export function stepWasHeld(step: { held?: boolean; request_meta?: unknown }): boolean {
  return coreStepWasHeld(step);
}

export function runDisplayState(
  status: string,
  outcome: { kind?: string } | null | undefined,
  heldEffects = false,
): string {
  return coreRunDisplayState(status, outcome, heldEffects);
}

export function runTraceEvidence(
  run: unknown,
  mayReadAudit: boolean,
): { id: string | null; href: string | null } {
  return coreRunTraceEvidence(run, mayReadAudit, (id) => auditHref({ traceId: id, scope: "all" }));
}

export function runPermissionBasis(
  value: unknown,
): "builtin_admin" | "resource_grant" | "group" | "role" | "portal_token_allowlist" | null {
  return coreRunPermissionBasis(value);
}

export function runPermissionEvidence(run: {
  permission_basis?: unknown;
  permission_phase?: unknown;
  permission_checked_at?: unknown;
}) {
  return coreRunPermissionEvidence(run);
}

export function lastRunLine(
  run:
    | (Pick<Execution, "status" | "started_at" | "created_at"> & {
        outcome?: { kind?: string } | null;
        held_effects?: boolean;
      })
    | null,
  t: Translate,
  locale: Locale,
  now: number = Date.now(),
): string {
  if (!run) return t("workflowStrip.line.runningNever");
  const when = formatRelativeTime(locale, run.started_at ?? run.created_at, now);
  const state = runDisplayState(run.status, run.outcome, run.held_effects);
  const tone = statusTone(state);
  return t(
    state === "held"
      ? "workflowStrip.line.ranHeld"
      : tone === "ok"
        ? "workflowStrip.line.running"
        : tone === "error"
          ? "workflowStrip.line.ranFailed"
          : "workflowStrip.line.ranOther",
    { when },
  );
}
