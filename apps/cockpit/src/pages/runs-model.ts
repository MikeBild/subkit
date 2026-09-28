import type { ReactNode } from "react";
import type { components } from "@/api/schema";
import { auditHref, uuidParam } from "@/app/links";
import { causeClassLabel } from "@/lib/cause-class";
import { LOCALE_TAGS, type Locale, type TranslationKey } from "@/lib/i18n";
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
  // A run started from this cockpit. It was missing, so thirty-three runs of a
  // production installation were labelled "unknown" by the very surface that
  // had started them — the page claiming not to recognise its own handwriting.
  ui: "runs.source.ui",
};

/**
 * The sources a reader can filter by, in the order they are offered.
 *
 * Derived from the label map, so a source added there is offered here and one
 * removed stops being offered — the drift that let `ui` reach the table as
 * "unknown" cannot repeat in the filter.
 */
export const REQUEST_SOURCES: readonly string[] = Object.keys(REQUEST_SOURCE_KEYS);

/**
 * Whether a value names a request source this build can describe.
 *
 * The filter a link asks for is checked against this, so an unrecognised value
 * narrows nothing instead of producing an empty list nobody can explain.
 * Derived from the label map rather than written out again: a source the page
 * cannot name is one it has no business filtering by.
 */
export function isKnownRequestSource(source: string): boolean {
  return source in REQUEST_SOURCE_KEYS;
}

/**
 * The filter a link asked for. "Production incidents: 1" pointed at the runs
 * page with no filter at all, so the reader landed on eleven thousand runs and
 * had to find the one themselves — a number that names something specific must
 * lead to that something. Unknown values are ignored rather than trusted.
 *
 * `source` was the second half of that. The status filter alone still handed
 * the reader nine hundred rows that were mostly authoring trials, for a number
 * whose definition says it excludes them. A parameter the link sends and the
 * page drops is indistinguishable from no filter at all.
 *
 * `workflow_id` is the third: a name search matches every workflow whose name
 * contains the words, and a renamed workflow not at all. The engine filters
 * `/v1/executions` by id, so a link that knows the workflow says which one.
 *
 * It lives here, beside the map it validates against, so it can be tested
 * without standing up the page. `runsHref` in app/links.ts builds what it reads.
 */
export interface RunsFilter {
  status: string;
  q: string;
  source: string;
  workflowId: string | null;
}

export function filterFromUrl(search: string): RunsFilter {
  const params = new URLSearchParams(search);
  const status = params.get("status") ?? "";
  const source = params.get("source") ?? "";
  return {
    status: RUN_STATUSES.includes(status as (typeof RUN_STATUSES)[number]) ? status : "all",
    q: (params.get("q") ?? "").slice(0, 200),
    source: isKnownRequestSource(source) ? source : "all",
    workflowId: uuidParam(params, "workflow_id"),
  };
}

/** The `/v1/executions` query for one page of a filter. */
export function executionsQuery(
  filter: RunsFilter,
  page: { limit: number; offset: number },
): URLSearchParams {
  const params = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset) });
  if (filter.status !== "all") params.set("status", filter.status);
  if (filter.source !== "all") params.set("request_source", filter.source);
  if (filter.workflowId) params.set("workflow_id", filter.workflowId);
  // The engine searches the whole log by the workflow's name. The list used
  // to narrow the page it had already fetched, which reads as search and is
  // not: a run outside the newest fifty could not be found by name at all.
  const needle = filter.q.trim();
  if (needle) params.set("q", needle);
  return params;
}

/**
 * The run an address names, or nothing.
 *
 * `/runs` had a list and no per-record path, so the sheet was reachable only
 * by clicking a row: an audit entry, a decision or a metric that named one run
 * could point at the list and no further. The id now lives in the path
 * (`app/route-table.ts`), and it is read here rather than in the page so the
 * reading can be proven without a DOM.
 *
 * Only the exact `/runs/<id>` shape is a run. The bare list, a trailing slash
 * and anything deeper are not, and guessing one out of them would open a sheet
 * on a record the address never named.
 */
export function runIdFromPath(pathname: string): string | null {
  const id = /\/runs\/([^/]+)$/.exec(pathname)?.[1];
  return id ? decodeURIComponent(id) : null;
}

/**
 * Is this answer an execution, or something else that arrived with a 200?
 *
 * The sheet already holds the run its list row carried, so the detail fetch
 * REFRESHES a record rather than filling an empty one — which makes
 * substituting whatever came back dangerous in a way it is not where the fetch
 * IS the data. A mistyped path, a proxy's courtesy page and the visual
 * fixture's catch-all all answer `{ items: [] }` with a 200. Taken for the
 * record, that object has no `status`, and the status label — reached with a
 * value its type says cannot be missing — took the whole page down with
 * `Cannot read properties of undefined (reading 'toLowerCase')`. Not a blank
 * sheet: a blank page, in front of someone who asked to see one run.
 *
 * The audit sheet has carried this guard since the same 200 blanked a complete
 * record there. This is the same rule at the second place that needed it.
 */
export function isExecutionRecord(value: unknown): value is Execution {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.status === "string";
}

/**
 * The text of a stored preview, or nothing when the step left none.
 *
 * `execution_steps.result_preview` is a **text** column holding the JSON
 * serialisation of what the step produced. A step that produced nothing stores
 * the four characters `null` — not SQL NULL — and `output_preview`, which is
 * `jsonb`, is SQL NULL in that same row. The sheet read
 * `output_preview ?? result_preview`, so the nullish coalescing skipped the
 * empty jsonb and handed the word `null` straight to the screen: production
 * showed a failed run whose heading "Ergebnis" was followed by `null`.
 *
 * That is a machine value rendered as prose — the same shape as §2's banned
 * "Unbekannt". A run that produced no result has no result section at all,
 * which is the truthful rendering of the third kind of emptiness: not zero,
 * not unmeasured, simply absent.
 *
 * Only the JSON literal is refused, and only when it is the whole value. A
 * preview whose content merely mentions null keeps it.
 */
export function previewText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const trimmed = text?.trim() ?? "";
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return null;
  return text;
}

export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * One row of the run sheet: a label, what the reader sees, and — only where
 * the displayed value is an abbreviated identifier — the whole value, which
 * the sheet hangs on the element's `title` so it stays copyable.
 *
 * The third slot is absent, not empty, on every row that shows its value in
 * full: an empty title would advertise a hidden value that isn't there.
 */
export type RunFact = [label: string, value: ReactNode, full?: string];

/**
 * A fact whose value is an identifier: shortened on screen, whole in the title.
 *
 * `shortIdentifier` truncates UUID-shaped text and nothing else, so a value it
 * returns untouched was never hidden and gets no title — the reader is not
 * told to hover over something they can already read in full.
 */
function identifierFact(label: string, value: string): RunFact {
  const shown = shortIdentifier(value);
  return shown === value ? [label, value] : [label, shown, value];
}

/** Describe the execution's stored binding, never the workflow's current grant. */
export function runAuthorityFacts(
  run: Pick<Execution, "execution_authority_id" | "workflow_version_id" | "hold_writes">,
  t: Translate,
): RunFact[] {
  return [
    ...(run.hold_writes ? [[t("runs.boundary"), t("runs.preparationDescription")] as RunFact] : []),
    // Both of these were printed raw, so the sheet put two 36-character UUIDs
    // in front of a person reading "which approval ran this" — the thing
    // UI-UX.md and COCKPIT-KONVENTION §5 forbid. `shortIdentifier` truncates
    // only UUID-shaped text, so a human-readable authority name survives
    // whole; the untruncated value stays reachable in the title.
    //
    // The absent case does NOT go through it: "No execution-authority binding
    // recorded" is a sentence stating a fact, not an identifier, and running
    // an absence through an id shortener is how absent starts looking like a
    // value someone merely couldn't be bothered to print.
    run.execution_authority_id != null
      ? identifierFact(t("authority.usedByRun"), run.execution_authority_id)
      : ([t("authority.usedByRun"), t("authority.noStoredBinding")] as RunFact),
    ...(run.workflow_version_id
      ? [identifierFact(t("authority.version"), run.workflow_version_id)]
      : []),
  ];
}

export function runName(run: Execution, t: Translate): string {
  if (run.workflow_name?.trim()) return run.workflow_name;
  return t(SOURCE_KIND_KEYS[run.source_kind] ?? "runs.sourceKind.saved");
}

/**
 * Who started a run, as a word — or the engine's own value, marked as one.
 *
 * A source this build has no word for used to read "Unbekannt", which is
 * false: the engine recorded exactly which source it was. §2 bans the word and
 * §15.2 names the replacement, the machine value recognisably as such.
 */
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

/**
 * What this run consumed, as facts beside its timing.
 *
 * `GET /v1/executions/{id}/cost` was built during a cost investigation that
 * had to be answered with raw SQL over ssh, and then no cockpit screen ever
 * called it. It is the only place in the API where a token figure and a money
 * figure sit side by side.
 *
 * Three deliberate readings:
 *
 * - A run that made no model call contributes NOTHING here rather than a row
 *   of zeros. "This run cost nothing" and "this run never called a model" are
 *   different facts, and a zero states the first.
 * - `external.cost_usd` is the only real money in the ledger; `llm_usage` has
 *   no monetary column at all. It is shown only when it is non-zero, because
 *   "$0.00" next to a run that did spend tokens reads as "this was free".
 * - The cache-read share is worth its own line: it is the difference between
 *   a turn that re-read a cached prompt and one that paid for it again, and
 *   it is the first thing anyone asks when a bill moves.
 */
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
        // The contract says 0–100 (`executions/cost.ts`, and the REPL footer
        // documents the same field the same way), so divide unconditionally.
        // Guessing the unit — "over one means percent" — was right for every
        // value above 1 and catastrophic below it: a run whose cache hit rate
        // had collapsed to 1 % emitted `1.0`, the guess left it alone, and the
        // page reported 100 %. It claimed caching was perfect at exactly the
        // moment it had stopped working.
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

/**
 * A run's outcome as one sentence — with the cause kept apart so the page can
 * set an unmapped class as a machine value instead of prose.
 *
 * `lead + cause.text + tail` is the whole sentence; `plain` is that string,
 * for tests and for places that only print text.
 */
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

/**
 * What happened to a run, composed from the engine's structured outcome — never
 * from its English error text.
 *
 * The step count is "n of m step(s)", singular only when there is exactly one
 * step: "1 von 1 Schritt", "2 von 3 Schritten".
 *
 * A failure names the step that STOPPED the run (`failed_step`, the engine's
 * `pickStoppingStep`), not the first step that happened to report an error —
 * an earlier `on_error: "continue"` failure stopped nothing.
 */
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

/**
 * The step whose error is THE run's error, shown once.
 *
 * The engine names it (`outcome.failed_step`). Only without an outcome — an
 * older engine — does the sheet fall back to the first step that carries an
 * error, which is what it always did.
 */
export function stoppingStep<T extends StepLike>(
  steps: readonly T[],
  outcome: ExecutionOutcome | null | undefined,
): T | null {
  const key = outcome?.failed_step?.step_key;
  if (key) {
    const named = steps.find((step) => step.step_key === key);
    if (named) return named;
  }
  if (outcome && outcome.kind !== "failed" && outcome.kind !== "partial") return null;
  return steps.find((step) => previewText(step.error) !== null) ?? null;
}

/**
 * The payload the sheet offers in its drawer, and what it is called.
 *
 * A SUCCEEDED run's last output is the run's result. A run that did not
 * succeed has no result: the newest output it holds is what one earlier step
 * produced, and labelling that "Ergebnis" told the reader a failed run had
 * delivered something. It carries its step instead.
 */
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
  // A held run wrote nothing: what it carries is the preview of a write that
  // was held back, and calling that "Ergebnis" presents a held publication as
  // executed. The engine reports such a run as `succeeded` with an outcome of
  // `held`, so the status alone cannot tell.
  if (outcome?.kind === "held") return { text, stepKey: null, preview: true };
  const succeeded = outcome ? outcome.kind === "succeeded" : runStatus === "succeeded";
  return { text, stepKey: succeeded ? null : last.step_key, preview: false };
}

/** The run statuses the engine counts as failed (`execution/outcome.ts`). */
export const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(["failed", "timed_out", "aborted"]);

/**
 * What the sheet says a run IS — its badge, and whether it gets a cause block.
 *
 * Read from the engine's outcome where there is one, because the status alone
 * lies twice: a held run and a partly failed run are both `succeeded`. The
 * first badge read "Erfolgreich" above "Vorbereitet, Schreibzugriffe
 * zurückgehalten", the second put "Erfolgreich" on a red cause block.
 *
 * Without an outcome (an older engine, a detail fetch that failed) the status
 * decides, and every status the engine counts as failed is one.
 */
export interface RunVerdict {
  label: string;
  /** The cause block's tone; null when there is nothing to explain. */
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

/**
 * The sentence for a failed run the engine gave no outcome for. A red badge
 * with no line under it is a red with no way to its cause (§1); this line
 * says what is known — how it ended — and the block still offers the fix.
 */
export function runStatusSentence(statusWord: string, t: Translate): OutcomeSentence {
  const plain = t("runs.outcome.statusOnly", { status: statusWord });
  return { lead: plain, cause: null, tail: "", plain };
}

/**
 * Why a rerun was refused, in words. The engine's known refusals get the
 * cockpit's sentence; anything else is the engine's own message, marked as
 * such — never a blanket "nothing was run" that hides the reason.
 */
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

/** The newest run that failed in any of the ways the engine counts, from a newest-first list. */
export function latestFailedRun<T extends { status: string }>(runs: readonly T[]): T | null {
  return runs.find((run) => FAILED_RUN_STATUSES.has(run.status)) ?? null;
}

/** The connector a step called, as the engine recorded it — for the sign-in remedy. */
export function stepConnectorId(step: StepLike | null): string | null {
  const meta = step?.request_meta;
  if (!meta || typeof meta !== "object") return null;
  const connector = (meta as { connector?: unknown }).connector;
  if (!connector || typeof connector !== "object") return null;
  const id = (connector as { connector_id?: unknown }).connector_id;
  return typeof id === "string" && id ? id : null;
}

/** Guidance an author or driver stored on the step's error, if any. */
export function stepGuidance(step: StepLike | null): string | null {
  const error = step?.error;
  if (!error || typeof error !== "object") return null;
  const guidance = (error as { guidance?: unknown }).guidance;
  return typeof guidance === "string" && guidance.trim() ? guidance : null;
}

/**
 * The quieter ways further from a run's cause block. The audit trail only for
 * a reader who may open it — a link that answers 403 is worse than none.
 */
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
