// Strategy #6 (last fallback): Chromium-driven sitemap + BFS crawl.
//
// Used when every cheaper strategy (openapi-direct, graphql-introspect,
// swagger-ui-scrape, llms-txt, html-scrape) has failed and we still need
// a documentation corpus to feed the agent. Headless Chromium can render
// SPA-style doc sites that the lightweight HTML scraper can't see, so
// this is the costliest but most permissive lever in the chain.
//
// Algorithm:
//   1. Try `<origin>/sitemap.xml` first; parse <loc> entries and rank.
//   2. If sitemap is empty / unreachable, BFS the doc root by extracting
//      same-origin anchor hrefs from the rendered DOM.
//   3. Score every candidate URL: paths containing api / endpoints /
//      reference / docs score higher; pricing / login / blog / legal
//      paths are penalised.
//   4. Visit the top N candidates, capture HTML, dedupe near-duplicates
//      via 5-shingle Jaccard (>0.7 → drop).
//   5. Concatenate kept HTML into a single text_corpus (capped at 200KB)
//      and return it. Endpoints stay empty — downstream strategies feed
//      the corpus into chunking / RAG, not the endpoint index.
//
// Wall-clock budget: 20s, enforced via `AbortSignal.timeout`. Any
// caller-provided `opts.signal` is honoured too. The strategy never
// shares a browser instance across calls — each fetch launches and
// closes its own Chromium so leaks don't cascade.

import { log } from "../../logging/logger.ts";
import { envCsvOr } from "../../utils/env-config.ts";
import { scrubUrl } from "../egress.ts";
import { htmlToMarkdown } from "./html-to-markdown.ts";
import {
  DiscoveryError,
  type DiscoveryResult,
  type DiscoveryStrategy,
  type DiscoveryStrategyOptions,
  type DiscoveryWarning,
} from "./types.ts";

const WALL_CLOCK_BUDGET_MS = 20_000;
const MAX_SITEMAP_ENTRIES = 50;
const MAX_BFS_LINKS = 50;
const TOP_CANDIDATES = 10;
const MAX_CORPUS_BYTES = 200 * 1024;
const JACCARD_THRESHOLD = 0.7;
const SHINGLE_SIZE = 5;

// Operator-tunable via DOCS_CRAWL_POSITIVE_HIGH / _LOW / _NEGATIVE env
// (CSV). Defaults are the conservative shipping list.
const POSITIVE_KEYWORDS_HIGH = envCsvOr("DOCS_CRAWL_POSITIVE_HIGH", [
  "api",
  "apis",
  "endpoints",
  "reference",
  "docs",
]);
const POSITIVE_KEYWORDS_LOW = envCsvOr("DOCS_CRAWL_POSITIVE_LOW", ["swagger", "openapi"]);
const NEGATIVE_KEYWORDS = envCsvOr("DOCS_CRAWL_NEGATIVE", [
  "pricing",
  "login",
  "signin",
  "signup",
  "/blog/",
  "careers",
  "/locale/",
  "/legal/",
  "/privacy/",
  "/terms/",
  "/contact/",
]);

// Path segments that are 2-letter (or 2-2 BCP-47) language codes — e.g.
// `/de/`, `/zh/`, `/zh-cn/`, `/pt-br/` — should be suppressed so the
// corpus isn't dominated by translated duplicates of the same docs.
// English and tokens that overlap with positive keywords (`api`) are
// allow-listed so we don't penalise legitimate paths.
const LOCALE_PATH_RE = /\/([a-z]{2}(?:-[a-z]{2,4})?)\//i;
const LOCALE_ALLOW = new Set(["en", "api"]);

interface ScoredUrl {
  url: string;
  score: number;
}

interface RankedCandidate {
  url: string;
  score: number;
}

/**
 * Subset of the playwright surface we need. Importing the full module
 * type would require playwright as a dev-time dependency at type-check
 * time; modelling it inline keeps the strategy testable without it.
 */
interface PlaywrightPage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  content(): Promise<string>;
  evaluate<T>(fn: () => T): Promise<T>;
  close(): Promise<void>;
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

export interface PlaywrightChromiumLauncher {
  launch(opts?: Record<string, unknown>): Promise<PlaywrightBrowser>;
}

/**
 * Override the chromium loader. Tests inject a fixture that returns a
 * stub browser; production calls fall through to dynamic-import the
 * real `playwright` package.
 */
let chromiumProvider: (() => Promise<PlaywrightChromiumLauncher>) | null = null;

export function setChromiumProviderForTesting(
  provider: (() => Promise<PlaywrightChromiumLauncher>) | null,
): void {
  chromiumProvider = provider;
}

async function loadChromium(): Promise<PlaywrightChromiumLauncher> {
  if (chromiumProvider) return chromiumProvider();
  try {
    // Indirected through a string + eval-like dynamic specifier so
    // TypeScript doesn't require the playwright type package at
    // type-check time. The runtime resolves the real module when the
    // strategy actually fires.
    const specifier = "playwright";
    const mod = (await (Function("s", "return import(s)") as (s: string) => Promise<unknown>)(
      specifier,
    )) as { chromium: PlaywrightChromiumLauncher };
    return mod.chromium;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DiscoveryError("playwright_failed", `playwright module unavailable: ${message}`);
  }
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function sameOrigin(candidate: string, base: string): boolean {
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * Score a URL by keyword relevance to API documentation. Higher is
 * more interesting; negative scores are suppressed. Only the path +
 * search portion of the URL is considered — otherwise a docs.* host
 * inflates every candidate score uniformly and drowns out the path
 * signal we actually care about.
 */
export function scoreCandidate(url: string): number {
  let pathLower: string;
  try {
    const parsed = new URL(url);
    pathLower = `${parsed.pathname}${parsed.search}`.toLowerCase();
  } catch {
    pathLower = url.toLowerCase();
  }
  let score = 0;
  for (const kw of POSITIVE_KEYWORDS_HIGH) {
    // Match path segments: ensure word-ish boundaries to avoid e.g.
    // "company-api-roadmap" double-counting beyond intent.
    const re = new RegExp(`(^|[^a-z])${kw}([^a-z]|$)`);
    if (re.test(pathLower)) score += 5;
  }
  for (const kw of POSITIVE_KEYWORDS_LOW) {
    if (pathLower.includes(kw)) score += 3;
  }
  for (const kw of NEGATIVE_KEYWORDS) {
    if (pathLower.includes(kw)) score -= 10;
  }
  const localeMatch = LOCALE_PATH_RE.exec(pathLower);
  if (localeMatch?.[1] && !LOCALE_ALLOW.has(localeMatch[1])) score -= 10;
  return score;
}

function rankUrls(urls: string[]): RankedCandidate[] {
  const seen = new Set<string>();
  const scored: ScoredUrl[] = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    scored.push({ url: u, score: scoreCandidate(u) });
  }
  // Stable sort: best score first, ties keep insertion order.
  scored.sort((a, b) => b.score - a.score);
  // Only keep positively-scored candidates — anything penalised by a
  // negative keyword (pricing/login/blog/legal/...) drops out so we
  // don't waste the budget on marketing pages.
  return scored.filter((c) => c.score > 0);
}

/**
 * Parse a sitemap.xml body into URL strings via simple regex on `<loc>`.
 * Handles standard sitemaps and sitemap-indexes (treats both equally —
 * we don't recurse into nested indexes, just lift every `<loc>`).
 */
export function parseSitemap(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null = re.exec(xml);
  while (m) {
    const v = m[1];
    if (v) out.push(v.trim());
    m = re.exec(xml);
  }
  return out;
}

/**
 * 5-shingle Jaccard similarity over normalised body text. Returns a
 * value in [0, 1]. Used to drop near-duplicate pages so the corpus
 * doesn't get dominated by repeating nav / footer content.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const s of sa) if (sb.has(s)) intersection++;
  const union = sa.size + sb.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function shingles(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const out = new Set<string>();
  if (tokens.length < SHINGLE_SIZE) {
    if (tokens.length > 0) out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i <= tokens.length - SHINGLE_SIZE; i++) {
    out.add(tokens.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return out;
}

function clipCorpus(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= MAX_CORPUS_BYTES) return text;
  return buf.subarray(0, MAX_CORPUS_BYTES).toString("utf8");
}

// Platform `AbortSignal.any` — the hand-rolled version leaked a listener
// onto the long-lived caller signal per crawl (never removed on completion).
function combineSignals(walltime: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  if (!caller) return walltime;
  return AbortSignal.any([walltime, caller]);
}

interface CrawlContext {
  signal: AbortSignal;
  warnings: DiscoveryWarning[];
}

async function loadSitemapCandidates(
  page: PlaywrightPage,
  origin: string,
  ctx: CrawlContext,
): Promise<string[]> {
  const sitemapUrl = `${origin}/sitemap.xml`;
  try {
    if (ctx.signal.aborted) return [];
    const response = (await page.goto(sitemapUrl, { timeout: 8_000 })) as {
      ok?: () => boolean;
      status?: () => number;
    } | null;
    const ok = response && typeof response.ok === "function" ? response.ok() : true;
    if (!ok) {
      ctx.warnings.push({
        code: "sitemap_unreachable",
        message: `sitemap.xml at ${scrubUrl(sitemapUrl)} returned non-2xx`,
      });
      return [];
    }
    const xml = await page.content();
    const urls = parseSitemap(xml).slice(0, MAX_SITEMAP_ENTRIES);
    if (urls.length === 0) {
      ctx.warnings.push({
        code: "sitemap_empty",
        message: `sitemap.xml at ${scrubUrl(sitemapUrl)} contained no <loc> entries`,
      });
    }
    return urls;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.warnings.push({ code: "sitemap_failed", message });
    return [];
  }
}

async function loadBfsCandidates(
  page: PlaywrightPage,
  baseUrl: string,
  ctx: CrawlContext,
): Promise<string[]> {
  try {
    if (ctx.signal.aborted) return [];
    await page.goto(baseUrl, { timeout: 8_000, waitUntil: "domcontentloaded" });
    const hrefs = await page.evaluate<string[]>(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
      return anchors.map((a) => a.href).filter((h): h is string => typeof h === "string");
    });
    const sameOriginLinks = hrefs.filter((h) => sameOrigin(h, baseUrl));
    return sameOriginLinks.slice(0, MAX_BFS_LINKS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.warnings.push({ code: "bfs_failed", message });
    return [];
  }
}

async function harvestPages(
  page: PlaywrightPage,
  candidates: RankedCandidate[],
  ctx: CrawlContext,
): Promise<{ url: string; html: string }[]> {
  const kept: { url: string; html: string }[] = [];
  let totalBytes = 0;
  for (const c of candidates) {
    if (ctx.signal.aborted) {
      ctx.warnings.push({
        code: "budget_exceeded",
        message: `wall-clock budget exhausted; skipped ${kept.length}/${candidates.length} pages`,
      });
      break;
    }
    if (totalBytes >= MAX_CORPUS_BYTES) {
      ctx.warnings.push({
        code: "corpus_full",
        message: `corpus cap reached at ${MAX_CORPUS_BYTES} bytes; skipping remaining pages`,
      });
      break;
    }
    try {
      await page.goto(c.url, { timeout: 8_000, waitUntil: "domcontentloaded" });
      const html = await page.content();
      // Jaccard-dedupe against pages already kept.
      let isDup = false;
      for (const prev of kept) {
        if (jaccardSimilarity(prev.html, html) > JACCARD_THRESHOLD) {
          isDup = true;
          break;
        }
      }
      if (isDup) {
        ctx.warnings.push({
          code: "page_filtered",
          message: `dropped ${scrubUrl(c.url)} as near-duplicate (jaccard > ${JACCARD_THRESHOLD})`,
        });
        log.debug({
          module: "connector",
          action: "discovery.strategy.page_filtered",
          strategy: "playwright-crawl",
          url: scrubUrl(c.url),
          reason: "jaccard_near_duplicate",
        });
        continue;
      }
      kept.push({ url: c.url, html });
      totalBytes += Buffer.byteLength(html, "utf8");
      log.debug({
        module: "connector",
        action: "discovery.strategy.page_fetched",
        strategy: "playwright-crawl",
        url: scrubUrl(c.url),
        score: c.score,
        bytes: Buffer.byteLength(html, "utf8"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.warnings.push({
        code: "page_fetch_failed",
        message: `failed to fetch ${scrubUrl(c.url)}: ${message}`,
      });
    }
  }
  return kept;
}

class PlaywrightCrawlStrategy implements DiscoveryStrategy {
  readonly name = "playwright-crawl" as const;

  canHandle(_url: string): boolean {
    // Last-resort strategy — always claims the URL so the chain reaches
    // it after every other strategy has skipped or thrown.
    return true;
  }

  async fetch(url: string, opts: DiscoveryStrategyOptions): Promise<DiscoveryResult> {
    log.debug({
      module: "connector",
      action: "discovery.strategy.started",
      strategy: this.name,
      url: scrubUrl(url),
    });

    const origin = originOf(url);
    if (!origin) {
      const failure = new DiscoveryError(
        "playwright_failed",
        `cannot derive origin from ${scrubUrl(url)}`,
      );
      log.warn({
        module: "connector",
        action: "discovery.strategy.failed",
        strategy: this.name,
        url: scrubUrl(url),
        code: failure.code,
        message: failure.message,
      });
      throw failure;
    }

    const wallTimer = AbortSignal.timeout(WALL_CLOCK_BUDGET_MS);
    const signal = combineSignals(wallTimer, opts.signal);

    const ctx: CrawlContext = { signal, warnings: [] };

    const chromium = await loadChromium();
    let browser: PlaywrightBrowser | null = null;
    let context: PlaywrightContext | null = null;
    let page: PlaywrightPage | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (compatible; SubkitDiscoveryBot/1.0; +https://subkit.dev)",
      });
      page = await context.newPage();

      // 1. Sitemap pass.
      let candidateUrls = await loadSitemapCandidates(page, origin, ctx);

      // 2. BFS fallback if sitemap dry.
      if (candidateUrls.length === 0) {
        candidateUrls = await loadBfsCandidates(page, url, ctx);
      }

      if (candidateUrls.length === 0) {
        const failure = new DiscoveryError(
          "playwright_failed",
          `no candidate URLs from sitemap or BFS at ${scrubUrl(url)}`,
        );
        log.warn({
          module: "connector",
          action: "discovery.strategy.failed",
          strategy: this.name,
          url: scrubUrl(url),
          code: failure.code,
          message: failure.message,
        });
        throw failure;
      }

      // 3. Rank by keyword relevance.
      const ranked = rankUrls(candidateUrls).slice(0, TOP_CANDIDATES);
      if (ranked.length === 0) {
        const failure = new DiscoveryError(
          "playwright_failed",
          `all ${candidateUrls.length} candidates filtered by negative keywords`,
        );
        log.warn({
          module: "connector",
          action: "discovery.strategy.failed",
          strategy: this.name,
          url: scrubUrl(url),
          code: failure.code,
          message: failure.message,
        });
        throw failure;
      }

      // 4. Visit + dedupe.
      const kept = await harvestPages(page, ranked, ctx);
      if (kept.length === 0) {
        const failure = new DiscoveryError(
          "playwright_failed",
          `every candidate failed or was filtered for ${scrubUrl(url)}`,
        );
        log.warn({
          module: "connector",
          action: "discovery.strategy.failed",
          strategy: this.name,
          url: scrubUrl(url),
          code: failure.code,
          message: failure.message,
        });
        throw failure;
      }

      // 5. Merge — convert each fragment to Markdown so the LLM gets
      // clean prose instead of raw HTML noise. Mirrors the reference
      // impl's HtmlMarkdownStrategy. Roughly 30-50% token savings on
      // typical docs pages.
      const merged = clipCorpus(
        kept.map((k) => `<!-- Source: ${k.url} -->\n${htmlToMarkdown(k.html)}`).join("\n\n"),
      );

      log.info({
        module: "connector",
        action: "discovery.strategy.succeeded",
        strategy: this.name,
        url: scrubUrl(url),
        kept_pages: kept.length,
        candidates: ranked.length,
        corpus_bytes: Buffer.byteLength(merged, "utf8"),
      });

      return {
        source_url: url,
        fetched_at: new Date().toISOString(),
        strategy: this.name,
        spec_version: null,
        title: null,
        servers: [origin],
        auth_schemes: [],
        endpoints: [],
        warnings: ctx.warnings,
        text_corpus: merged,
      };
    } catch (err) {
      if (err instanceof DiscoveryError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const failure = new DiscoveryError("playwright_failed", message);
      log.warn({
        module: "connector",
        action: "discovery.strategy.failed",
        strategy: this.name,
        url: scrubUrl(url),
        code: failure.code,
        message: failure.message,
      });
      throw failure;
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {}
      }
      if (context) {
        try {
          await context.close();
        } catch {}
      }
      if (browser) {
        try {
          await browser.close();
        } catch {}
      }
    }
  }
}

export const playwrightCrawlStrategy: DiscoveryStrategy = new PlaywrightCrawlStrategy();
