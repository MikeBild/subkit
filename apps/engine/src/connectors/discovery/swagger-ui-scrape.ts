// Strategy #2: documentation pages that embed Swagger UI but don't
// expose a direct spec link in the URL we were handed.
//
// Approach: GET the HTML, regex out the spec URL from the Swagger UI
// bootstrap (`SwaggerUIBundle({ url: "openapi.json", … })` or similar),
// resolve it relative to the doc page, then delegate to
// `openapi-direct` for the actual parse.

import { log } from "../../logging/logger.ts";
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

// Match `url: "..."` or `"url": "..."` against a value that looks like a
// JSON / YAML / openapi spec reference. Greedy on the path part to allow
// query strings.
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
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
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

/**
 * Find the first plausible spec URL embedded in the page HTML. Returns
 * `null` if none of the patterns match.
 */
export function extractEmbeddedSpecUrl(html: string, baseUrl: string): string | null {
  for (const re of SPEC_URL_PATTERNS) {
    const match = re.exec(html);
    if (match?.[1]) {
      try {
        return new URL(match[1], baseUrl).toString();
      } catch {
        // Pattern matched but the value isn't a resolvable URL — skip.
      }
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
    // Known doc-hosting hosts (e.g. SwaggerHub UI) have a deterministic
    // spec URL — skip the HTML scrape entirely and delegate to direct.
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
      log.warn({
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
