import { log } from "../../logging/logger.ts";
import { getDriverFetch } from "../drivers/fetch-seam.ts";
import { scrubUrl } from "../egress.ts";
import { assertEgressAllowed } from "../egress-guard.ts";
import { normalizeKnownHosts, openApiDirectStrategy } from "./openapi-direct.ts";
import {
  DiscoveryError,
  type DiscoveryResult,
  type DiscoveryStrategy,
  type DiscoveryStrategyOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

const SPEC_URL_PATTERNS: RegExp[] = [
  /["']?url["']?\s*:\s*["']([^"']+\.ya?ml(?:\?[^"']*)?)["']/i,
  /["']?url["']?\s*:\s*["']([^"']+\.json(?:\?[^"']*)?)["']/i,
  /["']?url["']?\s*:\s*["']([^"']*\/openapi[^"']*)["']/i,
  /["']?url["']?\s*:\s*["']([^"']*\/swagger[^"']*)["']/i,
  /SwaggerUIBundle\([^)]*url\s*:\s*["']([^"']+)["']/i,
];

async function fetchHtml(url: string, opts: DiscoveryStrategyOptions): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const headers: Record<string, string> = {
      accept: "text/html, */*",
      ...(opts.headers ?? {}),
    };
    assertEgressAllowed(url, {});
    const res = await getDriverFetch()(url, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) {
      throw new DiscoveryError(`http_${res.status}`, `GET ${scrubUrl(url)} returned ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_HTML_BYTES) {
      throw new DiscoveryError(
        "html_too_large",
        `HTML at ${scrubUrl(url)} exceeds ${MAX_HTML_BYTES} bytes`,
      );
    }
    return new TextDecoder().decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

export function extractEmbeddedSpecUrl(html: string, baseUrl: string): string | null {
  for (const re of SPEC_URL_PATTERNS) {
    const match = re.exec(html);
    if (match?.[1]) {
      try {
        return new URL(match[1], baseUrl).toString();
      } catch {}
    }
  }
  return null;
}

class SwaggerUiScrapeStrategy implements DiscoveryStrategy {
  readonly name = "swagger-ui-scrape" as const;

  canHandle(_url: string): boolean {
    return true;
  }

  async fetch(url: string, opts: DiscoveryStrategyOptions): Promise<DiscoveryResult> {
    log.debug({
      module: "connector",
      action: "discovery.strategy.started",
      strategy: this.name,
      url: scrubUrl(url),
    });
    const rewritten = normalizeKnownHosts(url);
    if (rewritten !== url) {
      const inner = await openApiDirectStrategy.fetch(rewritten, opts);
      log.info({
        module: "connector",
        action: "discovery.strategy.succeeded",
        strategy: this.name,
        url: scrubUrl(url),
        embedded_spec_url: scrubUrl(rewritten),
        endpoints: inner.endpoints.length,
        via: "known_host_rewrite",
      });
      return { ...inner, strategy: this.name };
    }
    try {
      const html = await fetchHtml(url, opts);
      const specUrl = extractEmbeddedSpecUrl(html, url);
      if (!specUrl) {
        throw new DiscoveryError(
          "spec_not_found",
          `no embedded spec URL found in ${scrubUrl(url)}`,
        );
      }
      const inner = await openApiDirectStrategy.fetch(specUrl, opts);
      log.info({
        module: "connector",
        action: "discovery.strategy.succeeded",
        strategy: this.name,
        url: scrubUrl(url),
        embedded_spec_url: scrubUrl(specUrl),
        endpoints: inner.endpoints.length,
      });
      return { ...inner, strategy: this.name };
    } catch (err) {
      const code = err instanceof DiscoveryError ? err.code : "scrape_failed";
      const message = err instanceof Error ? err.message : String(err);
      log.debug({
        module: "connector",
        action: "discovery.strategy.failed",
        strategy: this.name,
        url: scrubUrl(url),
        code,
        message,
      });
      if (err instanceof DiscoveryError) throw err;
      throw new DiscoveryError(code, message);
    }
  }
}

export const swaggerUiScrapeStrategy: DiscoveryStrategy = new SwaggerUiScrapeStrategy();
