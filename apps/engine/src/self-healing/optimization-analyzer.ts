// Post-execution optimisation analyzer for the web-scraper connector.
//
// Pure functions that classify recent runs of a web-scraper workflow
// and emit optimization-candidate proposals. The pg-boss scheduler
// invocation lives in `queue/handlers/optimization-scan.ts` (follow-up);
// the analyzer itself is pure so it can be unit-tested and called
// from the chat surface ("show me optimisations for my scrapers")
// without booting a worker.
//
// Tunables (`config.connectors.web_scraper.optimization.*` — tenant-
// scoped where it makes sense): see `config/schema.ts`.

export type OptimizationKind =
  "narrow_path_prefix" | "raise_max_chars" | "increase_wait_ms" | "prefer_llms_txt";

export interface OptimizationCandidate {
  kind: OptimizationKind;
  rationale: string;
  estimated_savings_pct: number | null;
  diff: Record<string, unknown>;
  classification: "safe" | "unsafe";
}

/** Compact view of a single recent run the analyzer needs. */
export interface AnalyzerRunSample {
  /** Number of pages the run produced (loop iterations). */
  pages_total: number;
  /** Pages whose MarkdownOutput.bytes < trivial_markdown_bytes. */
  pages_trivial: number;
  /** Pages that failed with error_code === "extract_too_large". */
  pages_extract_too_large: number;
  /** Mean wait between pages, milliseconds. */
  mean_wait_ms: number;
  /** Number of HTTP 429 (rate-limited) responses on this run. */
  rate_limit_hits: number;
}

export interface AnalyzerConfig {
  trivial_markdown_bytes: number;
  min_runs_before_proposing: number;
  /** Mostly relevant when the recipe is `crawl-sitemap-to-markdown`;
   *  governs `prefer_llms_txt` proposals. */
  llms_txt_available: boolean;
}

/**
 * Score the last N runs of one workflow → recipe pair and return a list
 * of optimisation candidates (zero or more). Pure: no DB, no clock.
 */
export function analyzeRuns(
  runs: readonly AnalyzerRunSample[],
  config: AnalyzerConfig,
): OptimizationCandidate[] {
  const candidates: OptimizationCandidate[] = [];
  if (runs.length < config.min_runs_before_proposing) return candidates;

  const totalPages = runs.reduce((s, r) => s + r.pages_total, 0);
  if (totalPages === 0) return candidates;

  const trivialRatio = runs.reduce((s, r) => s + r.pages_trivial, 0) / totalPages;
  if (trivialRatio >= 0.9) {
    candidates.push({
      kind: "narrow_path_prefix",
      rationale: `${Math.round(trivialRatio * 100)}% of crawled pages produced trivial markdown (< ${config.trivial_markdown_bytes} bytes). Propose: narrow the crawl to a path prefix that excludes the empty pages.`,
      estimated_savings_pct: Math.round(trivialRatio * 100),
      diff: { suggest: "narrow_path_prefix" },
      classification: "safe",
    });
  }

  const tooLargeRatio = runs.reduce((s, r) => s + r.pages_extract_too_large, 0) / totalPages;
  if (tooLargeRatio >= 0.3) {
    candidates.push({
      kind: "raise_max_chars",
      rationale: `${Math.round(tooLargeRatio * 100)}% of pages hit extract_too_large. Propose: raise connectors.web_scraper.runtime.max_chars_markdown (and/or max_chars_readability) by 2-3× OR add transform.markdown.truncate=true to soft-truncate at the cap.`,
      estimated_savings_pct: null,
      diff: { suggest: "raise_max_chars" },
      classification: "safe",
    });
  }

  const totalRateLimit = runs.reduce((s, r) => s + r.rate_limit_hits, 0);
  if (totalRateLimit >= 5) {
    const meanWaitMs = runs.reduce((s, r) => s + r.mean_wait_ms, 0) / runs.length;
    candidates.push({
      kind: "increase_wait_ms",
      rationale: `Origin returned 429 ${totalRateLimit} times across the last ${runs.length} runs (mean wait_ms=${Math.round(meanWaitMs)}). Propose: raise connectors.web_scraper.runtime.default_wait_ms to ${Math.max(Math.round(meanWaitMs * 2), 250)}.`,
      estimated_savings_pct: null,
      diff: { suggest: "increase_wait_ms", new_value: Math.max(Math.round(meanWaitMs * 2), 250) },
      classification: "safe",
    });
  }

  if (config.llms_txt_available && trivialRatio >= 0.5) {
    candidates.push({
      kind: "prefer_llms_txt",
      rationale: `Origin publishes /llms.txt and ${Math.round(trivialRatio * 100)}% of crawled pages produced trivial markdown. Propose: replace the sitemap crawl with the existing llms-txt ingestion source — bytes saved, less stress on the origin, deterministic shape.`,
      estimated_savings_pct: Math.round(trivialRatio * 80),
      diff: { suggest: "prefer_llms_txt" },
      classification: "safe",
    });
  }

  return candidates;
}
