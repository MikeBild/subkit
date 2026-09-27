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
 * It lives here, beside the map it validates against, so it can be tested
 * without standing up the page.
 */
export function filterFromUrl(search: string): { status: string; q: string; source: string } {
  const params = new URLSearchParams(search);
  const status = params.get("status") ?? "";
  const source = params.get("source") ?? "";
  return {
    status: RUN_STATUSES.includes(status as (typeof RUN_STATUSES)[number]) ? status : "all",
    q: (params.get("q") ?? "").slice(0, 200),
    source: isKnownRequestSource(source) ? source : "all",
  };
}

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
