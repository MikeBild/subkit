// Public entry point: orchestrate the multi-strategy fallback chain.
//
// `discoverConnectorEndpoints` resolves an input URL (from a template
// slug, an explicit `ingestion_url`, or a `base_url` walked against
// well-known paths) and runs strategies in order:
//   1. openapi-direct
//   2. graphql-introspect
//   3. swagger-ui-scrape
//   4. llms-txt
//   5. html-scrape
// Each failed strategy contributes a warning to the final result if a
// later strategy succeeds. If all strategies fail, the function throws
// `DiscoveryError("all_strategies_failed", …)` with aggregated reasons.
//
// When the caller hands us a template whose `ingestion_source` is
// `graphql` or `llms_txt` we promote the matching strategy to the head
// of the chain so we don't waste a round-trip on `openapi-direct`.
//
// Caching is intentionally NOT done here — the conversation tool wrapper
// owns persisting the result as a `knowledge_sources` row. This module
// is pure compute.

import { log } from "../../logging/logger.ts";
import { scrubUrl } from "../egress.ts";
import { getBuiltinTemplate } from "../templates.ts";
import { graphqlIntrospectStrategy } from "./graphql-introspect.ts";
import { htmlScrapeStrategy } from "./html-scrape.ts";
import { llmsTxtStrategy } from "./llms-txt.ts";
import { openApiDirectStrategy } from "./openapi-direct.ts";
import { playwrightCrawlStrategy } from "./playwright-crawl.ts";
import { swaggerUiScrapeStrategy } from "./swagger-ui-scrape.ts";
import {
  DiscoveryError,
  type DiscoveryResult,
  type DiscoveryStrategy,
  type DiscoveryStrategyOptions,
  type DiscoveryWarning,
} from "./types.ts";

export { graphqlIntrospectStrategy, looksLikeGraphQLUrl } from "./graphql-introspect.ts";
export { extractSpecHrefs, htmlScrapeStrategy } from "./html-scrape.ts";
export { llmsTxtStrategy } from "./llms-txt.ts";
export { normalizeSpec, openApiDirectStrategy } from "./openapi-direct.ts";
export {
  jaccardSimilarity,
  parseSitemap,
  playwrightCrawlStrategy,
  scoreCandidate,
  setChromiumProviderForTesting,
} from "./playwright-crawl.ts";
export { extractEmbeddedSpecUrl, swaggerUiScrapeStrategy } from "./swagger-ui-scrape.ts";
export * from "./types.ts";

export interface DiscoverConnectorEndpointsInput {
  template_id?: string;
  base_url?: string;
  ingestion_url?: string;
  signal?: AbortSignal;
  /** Optional headers forwarded to every strategy fetch (e.g. user-agent). */
  headers?: Record<string, string>;
  /** Override strategy order (mostly for tests). */
  strategies?: DiscoveryStrategy[];
}

const DEFAULT_STRATEGIES: DiscoveryStrategy[] = [
  openApiDirectStrategy,
  graphqlIntrospectStrategy,
  swaggerUiScrapeStrategy,
  llmsTxtStrategy,
  htmlScrapeStrategy,
  // playwright-crawl is the costliest strategy (launches Chromium) and
  // therefore always runs last, never gets promoted by template hints.
  playwrightCrawlStrategy,
];

/**
 * If the resolved template hints at GraphQL or llms.txt ingestion,
 * promote that strategy to the front of the chain. Other strategies
 * follow in their canonical order so we still attempt fallbacks if the
 * primary fails.
 *
 * `playwright-crawl` is never promoted — it's the costliest strategy
 * (launches headless Chromium) and stays pinned to the tail of the
 * chain regardless of template hints.
 */
function reorderStrategiesForTemplate(
  templateId: string | undefined,
  base: DiscoveryStrategy[],
): DiscoveryStrategy[] {
  if (!templateId) return base;
  const tmpl = getBuiltinTemplate(templateId);
  if (!tmpl) return base;
  const promote = (name: DiscoveryStrategy["name"]): DiscoveryStrategy[] => {
    if (name === "playwright-crawl") return base; // never promote
    const idx = base.findIndex((s) => s.name === name);
    if (idx <= 0) return base;
    const head = base[idx];
    if (!head) return base;
    return [head, ...base.slice(0, idx), ...base.slice(idx + 1)];
  };
  if (tmpl.ingestion_source === "graphql") return promote("graphql-introspect");
  if (tmpl.ingestion_source === "llms_txt") return promote("llms-txt");
  return base;
}

function resolveSourceUrl(input: DiscoverConnectorEndpointsInput): string {
  if (input.ingestion_url) return input.ingestion_url;
  if (input.template_id) {
    const tmpl = getBuiltinTemplate(input.template_id);
    if (!tmpl) {
      throw new DiscoveryError(
        "template_not_found",
        `no built-in template with slug '${input.template_id}'`,
      );
    }
    if (tmpl.ingestion_url) return tmpl.ingestion_url;
    if (tmpl.base_url) return tmpl.base_url;
    throw new DiscoveryError(
      "template_no_url",
      `template '${input.template_id}' has neither ingestion_url nor base_url`,
    );
  }
  if (input.base_url) return input.base_url;
  throw new DiscoveryError(
    "no_url_provided",
    "discoverConnectorEndpoints requires template_id, ingestion_url, or base_url",
  );
}

/**
 * Run the multi-strategy fallback chain. Strategies execute sequentially;
 * the first to return a `DiscoveryResult` wins. Earlier failures attach
 * as warnings on the winning result.
 */
export async function discoverConnectorEndpoints(
  input: DiscoverConnectorEndpointsInput,
): Promise<DiscoveryResult> {
  const url = resolveSourceUrl(input);
  const strategies =
    input.strategies ?? reorderStrategiesForTemplate(input.template_id, DEFAULT_STRATEGIES);
  const opts: DiscoveryStrategyOptions = {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
  };

  const warnings: DiscoveryWarning[] = [];

  for (const strategy of strategies) {
    try {
      const canHandle = await Promise.resolve(strategy.canHandle(url));
      if (!canHandle) {
        warnings.push({
          code: "strategy_skipped",
          message: `${strategy.name} declined ${scrubUrl(url)}`,
        });
        continue;
      }
      const result = await strategy.fetch(url, opts);
      return { ...result, warnings: [...warnings, ...result.warnings] };
    } catch (err) {
      const code = err instanceof DiscoveryError ? err.code : "strategy_failed";
      const message = err instanceof Error ? err.message : String(err);
      warnings.push({ code: `${strategy.name}:${code}`, message });
    }
  }

  log.warn({
    module: "connector",
    action: "discovery.all_failed",
    url: scrubUrl(url),
    attempts: warnings.length,
  });

  const aggregated = warnings.map((w) => `${w.code}: ${w.message}`).join("; ");
  throw new DiscoveryError(
    "all_strategies_failed",
    `discovery failed for ${scrubUrl(url)} — ${aggregated || "no strategies attempted"}`,
  );
}
