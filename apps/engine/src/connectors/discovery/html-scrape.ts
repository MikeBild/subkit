import { log } from "../../logging/index.ts";
import { getDriverFetch } from "../drivers/fetch-seam.ts";
import { scrubUrl } from "../egress.ts";
import { assertEgressAllowed } from "../egress-guard.ts";
import { openApiDirectStrategy } from "./openapi-direct.ts";
import {
  DiscoveryError,
  type DiscoveryResult,
  type DiscoveryStrategy,
  type DiscoveryStrategyOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

export const WELL_KNOWN_PATHS: string[] = [
  "/openapi.json",
  "/openapi.yaml",
  "/openapi.yml",
  "/swagger.json",
  "/swagger.yaml",
  "/v1/openapi.json",
  "/v1/openapi.yaml",
  "/v2/openapi.json",
  "/v3/openapi.json",
  "/api/openapi.json",
  "/api/openapi.yaml",
  "/api-docs",
  "/api-docs.json",
  "/docs/openapi.json",
  "/docs/openapi.yaml",
  "/.well-known/openapi.json",
  "/.well-known/openapi.yaml",
];

const HREF_PATTERNS: RegExp[] = [
  /<a[^>]+href\s*=\s*["']([^"']*openapi[^"']*\.(?:json|ya?ml))["']/gi,
  /<a[^>]+href\s*=\s*["']([^"']*swagger[^"']*\.(?:json|ya?ml))["']/gi,
  /<link[^>]+href\s*=\s*["']([^"']*openapi[^"']*\.(?:json|ya?ml))["']/gi,
  /href\s*=\s*["']([^"']*\/openapi(?:\.json|\.ya?ml)?)["']/gi,
];

async function fetchHtml(url: string, opts: DiscoveryStrategyOptions): Promise<string | null> {
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
    if (!res.ok) return null;
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

export function extractSpecHrefs(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of HREF_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null = re.exec(html);
    while (match) {
      const candidate = match[1];
      if (!candidate) {
        match = re.exec(html);
        continue;
      }
      try {
        const resolved = new URL(candidate, baseUrl).toString();
        if (!seen.has(resolved)) {
          seen.add(resolved);
          out.push(resolved);
        }
      } catch {}
      match = re.exec(html);
    }
  }
  return out;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

async function tryCandidate(
  candidate: string,
  opts: DiscoveryStrategyOptions,
): Promise<DiscoveryResult | null> {
  try {
    return await openApiDirectStrategy.fetch(candidate, opts);
  } catch {
    return null;
  }
}

class HtmlScrapeStrategy implements DiscoveryStrategy {
  readonly name = "html-scrape" as const;

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

    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (c: string): void => {
      if (!seen.has(c)) {
        seen.add(c);
        candidates.push(c);
      }
    };

    let html: string | null = null;
    try {
      html = await fetchHtml(url, opts);
    } catch (err) {
      if (err instanceof DiscoveryError) {
        log.debug({
          module: "connector",
          action: "discovery.strategy.failed",
          strategy: this.name,
          url: scrubUrl(url),
          code: err.code,
          message: err.message,
        });
        throw err;
      }
    }
    if (html) {
      for (const href of extractSpecHrefs(html, url)) push(href);
    }

    const origin = originOf(url);
    if (origin) {
      for (const p of WELL_KNOWN_PATHS) push(`${origin}${p}`);
    }

    for (const candidate of candidates) {
      const result = await tryCandidate(candidate, opts);
      if (result) {
        log.info({
          module: "connector",
          action: "discovery.strategy.succeeded",
          strategy: this.name,
          url: scrubUrl(url),
          matched: scrubUrl(candidate),
          endpoints: result.endpoints.length,
        });
        return { ...result, strategy: this.name };
      }
    }

    const failure = new DiscoveryError(
      "spec_not_found",
      `no spec located via HTML scrape from ${scrubUrl(url)} (tried ${candidates.length} candidates)`,
    );
    log.debug({
      module: "connector",
      action: "discovery.strategy.failed",
      strategy: this.name,
      url: scrubUrl(url),
      code: failure.code,
      message: failure.message,
    });
    throw failure;
  }
}

export const htmlScrapeStrategy: DiscoveryStrategy = new HtmlScrapeStrategy();
