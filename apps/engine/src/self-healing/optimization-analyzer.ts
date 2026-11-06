export type OptimizationKind =
  | "narrow_path_prefix"
  | "raise_max_chars"
  | "increase_wait_ms"
  | "prefer_llms_txt";

interface OptimizationCandidate {
  kind: OptimizationKind;
  rationale: string;
  estimated_savings_pct: number | null;
  diff: Record<string, unknown>;
  classification: "safe" | "unsafe";
}

export interface AnalyzerRunSample {
  pages_total: number;
  pages_trivial: number;
  pages_extract_too_large: number;
  mean_wait_ms: number;
  rate_limit_hits: number;
}

export interface AnalyzerConfig {
  trivial_markdown_bytes: number;
  min_runs_before_proposing: number;
  llms_txt_available: boolean;
}

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
