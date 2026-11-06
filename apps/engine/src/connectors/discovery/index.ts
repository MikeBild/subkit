import { log } from "../../logging/logger.ts";
import { getDriverFetch, withDriverFetch } from "../drivers/fetch-seam.ts";
import { validateOutboundHeaders } from "../drivers/http.ts";
import { scrubUrl } from "../egress.ts";
import { guardedFetch } from "../egress-fetch.ts";
import {
  type EgressTenantScope,
  resolveEgressGuardMode,
  resolveTenantEgressContext,
} from "../egress-guard.ts";
import { getBuiltinTemplate } from "../templates.ts";
import { graphqlIntrospectStrategy } from "./graphql-introspect.ts";
import { htmlScrapeStrategy } from "./html-scrape.ts";
import { llmsTxtStrategy } from "./llms-txt.ts";
import { openApiDirectStrategy } from "./openapi-direct.ts";
import { PLAYWRIGHT_UNAVAILABLE_MESSAGE, playwrightCrawlStrategy } from "./playwright-crawl.ts";
import { postgresIntrospectStrategy } from "./postgres-introspect.ts";
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
  PLAYWRIGHT_UNAVAILABLE_MESSAGE,
  parseSitemap,
  playwrightCrawlStrategy,
  scoreCandidate,
  setChromiumProviderForTesting,
} from "./playwright-crawl.ts";
export {
  looksLikePostgresUrl,
  postgresIntrospectStrategy,
  renderSchemaMarkdown,
} from "./postgres-introspect.ts";
export { extractEmbeddedSpecUrl, swaggerUiScrapeStrategy } from "./swagger-ui-scrape.ts";
export * from "./types.ts";

export type DiscoverConnectorEndpointsInput = EgressTenantScope & {
  template_id?: string;
  base_url?: string;
  ingestion_url?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  strategies?: DiscoveryStrategy[];
};

const DEFAULT_STRATEGIES: DiscoveryStrategy[] = [
  postgresIntrospectStrategy,
  openApiDirectStrategy,
  graphqlIntrospectStrategy,
  swaggerUiScrapeStrategy,
  llmsTxtStrategy,
  htmlScrapeStrategy,
  playwrightCrawlStrategy,
];

function reorderStrategiesForTemplate(
  templateId: string | undefined,
  base: DiscoveryStrategy[],
): DiscoveryStrategy[] {
  if (!templateId) return base;
  const tmpl = getBuiltinTemplate(templateId);
  if (!tmpl) return base;
  const promote = (name: DiscoveryStrategy["name"]): DiscoveryStrategy[] => {
    if (name === "playwright-crawl") return base;
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

export async function discoverConnectorEndpoints(
  input: DiscoverConnectorEndpointsInput,
): Promise<DiscoveryResult> {
  const url = resolveSourceUrl(input);
  if (input.headers !== undefined) {
    validateOutboundHeaders(input.headers);
  }
  const strategies =
    input.strategies ?? reorderStrategiesForTemplate(input.template_id, DEFAULT_STRATEGIES);
  const scope: EgressTenantScope = input.tenant_id
    ? { tenant_id: input.tenant_id, exec: input.exec }
    : {};
  const opts: DiscoveryStrategyOptions = {
    ...scope,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
  };

  const warnings: DiscoveryWarning[] = [];
  const context = await resolveTenantEgressContext(scope);
  const transport = guardedFetch(context, getDriverFetch());
  let authRequired: DiscoveryWarning | null = null;

  for (const strategy of strategies) {
    try {
      if (strategy.name === "playwright-crawl" && resolveEgressGuardMode(context) === "strict") {
        throw new DiscoveryError(
          "strategy_failed",
          "Browser discovery requires an operator-reviewed network boundary; use a public API specification or HTTP discovery instead",
        );
      }
      const canHandle = await Promise.resolve(strategy.canHandle(url));
      if (!canHandle) {
        warnings.push({
          code: "strategy_skipped",
          message:
            strategy.name === "playwright-crawl"
              ? PLAYWRIGHT_UNAVAILABLE_MESSAGE
              : `${strategy.name} declined ${scrubUrl(url)}`,
        });
        continue;
      }
      const result = await withDriverFetch(transport, () => strategy.fetch(url, opts));
      return { ...result, warnings: [...warnings, ...result.warnings] };
    } catch (err) {
      const code = err instanceof DiscoveryError ? err.code : "strategy_failed";
      const message = err instanceof Error ? err.message : String(err);
      const warning: DiscoveryWarning = { code: `${strategy.name}:${code}`, message };
      warnings.push(warning);
      if (!authRequired && isAuthRequiredCode(code)) {
        authRequired = warning;
      }
    }
  }

  if (authRequired) {
    log.warn({
      module: "connector",
      action: "discovery.auth_required",
      url: scrubUrl(url),
      code: authRequired.code,
      attempts: warnings.length,
    });
    throw new DiscoveryError(
      "auth_required",
      `discovery for ${scrubUrl(url)} needs credentials — ${authRequired.message}`,
    );
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

function isAuthRequiredCode(code: string): boolean {
  return code === "auth_required" || /(^|_)40[13]$/.test(code);
}
