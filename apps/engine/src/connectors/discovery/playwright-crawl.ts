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

interface PlaywrightChromiumLauncher {
  launch(opts?: Record<string, unknown>): Promise<PlaywrightBrowser>;
}

let chromiumProvider: (() => Promise<PlaywrightChromiumLauncher>) | null = null;

let availabilityProbe: Promise<boolean> | null = null;

export function setChromiumProviderForTesting(
  provider: (() => Promise<PlaywrightChromiumLauncher>) | null,
): void {
  chromiumProvider = provider;
  availabilityProbe = null;
}

async function loadChromium(): Promise<PlaywrightChromiumLauncher> {
  if (chromiumProvider) return chromiumProvider();
  try {
    const specifier = process.env.SK_PLAYWRIGHT_ENTRY || "playwright";
    const mod = (await (Function("s", "return import(s)") as (s: string) => Promise<unknown>)(
      specifier,
    )) as { chromium: PlaywrightChromiumLauncher };
    return mod.chromium;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DiscoveryError("playwright_failed", `playwright module unavailable: ${message}`);
  }
}

export const PLAYWRIGHT_UNAVAILABLE_MESSAGE =
  "browser discovery is not available: this engine has no Playwright module (the SubKit container image ships no browser); set SK_PLAYWRIGHT_ENTRY to an installed Playwright module to enable it";

function isPlaywrightAvailable(): Promise<boolean> {
  if (!availabilityProbe) {
    availabilityProbe = loadChromium().then(
      () => true,
      (err: unknown) => {
        log.info({
          module: "connector",
          action: "discovery.strategy.unavailable",
          strategy: "playwright-crawl",
          message: PLAYWRIGHT_UNAVAILABLE_MESSAGE,
          reason: err instanceof Error ? err.message : String(err),
        });
        return false;
      },
    );
  }
  return availabilityProbe;
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
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((c) => c.score > 0);
}

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

  canHandle(_url: string): Promise<boolean> {
    return isPlaywrightAvailable();
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

      let candidateUrls = await loadSitemapCandidates(page, origin, ctx);

      if (candidateUrls.length === 0) {
        candidateUrls = await loadBfsCandidates(page, url, ctx);
      }

      if (candidateUrls.length === 0) {
        const failure = new DiscoveryError(
          "playwright_failed",
          `no candidate URLs from sitemap or BFS at ${scrubUrl(url)}`,
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

      const ranked = rankUrls(candidateUrls).slice(0, TOP_CANDIDATES);
      if (ranked.length === 0) {
        const failure = new DiscoveryError(
          "playwright_failed",
          `all ${candidateUrls.length} candidates filtered by negative keywords`,
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

      const kept = await harvestPages(page, ranked, ctx);
      if (kept.length === 0) {
        const failure = new DiscoveryError(
          "playwright_failed",
          `every candidate failed or was filtered for ${scrubUrl(url)}`,
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
      log.debug({
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
