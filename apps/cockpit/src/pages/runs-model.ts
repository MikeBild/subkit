import type { components } from "@/api/schema";
import { LOCALE_TAGS, type Locale, type TranslationKey } from "@/lib/i18n";
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
export type RunFact = [label: string, value: string, full?: string];

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
