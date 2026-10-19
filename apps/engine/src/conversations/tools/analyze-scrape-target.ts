import { z } from "@hono/zod-openapi";
import { getConfig } from "../../config/loader.ts";
import { getDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
import { assertEgressAllowedResolved, EgressBlockedError } from "../../connectors/egress-guard.ts";
import { getRobotsVerification, guardedFetch, readBodyCapped } from "../../connectors/index.ts";
import { logger } from "../../logging/logger.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const SITEMAP_FETCH_TIMEOUT_MS = 5_000;
export const SITEMAP_MAX_BYTES = 8 * 1024 * 1024;

const inputSchema = z
  .object({
    target_url: z.string().url(),
    sitemap_url: z.string().url().optional(),
  })
  .openapi("AnalyzeScrapeTargetToolInput");

interface ProbeResult {
  verdict: "green" | "yellow" | "red";
  message: string;
  sitemap_entry_count: number | null;
  robots_disallowed: boolean;
  details: Record<string, unknown>;
}

const SITEMAP_LOC_RE = /<loc>\s*([^<\s]+?)\s*<\/loc>/gi;

function hasSitemapRoot(text: string): boolean {
  let source = text.trim();
  while (source.startsWith("<?xml") || source.startsWith("<!--")) {
    const marker = source.startsWith("<?xml") ? "?>" : "-->";
    const end = source.indexOf(marker);
    if (end < 0) return false;
    source = source.slice(end + marker.length).trimStart();
  }
  const opening = /^<(urlset|sitemapindex)(?=[\s/>])/i.exec(source);
  if (!opening) return false;
  const openingEnd = source.indexOf(">");
  if (openingEnd < 0 || source.slice(1, openingEnd).includes("<")) return false;
  if (source[openingEnd - 1] === "/") return source.slice(openingEnd + 1).trim().length === 0;
  const closingStart = source.lastIndexOf("</");
  if (closingStart <= openingEnd) return false;
  const closing = /^<\/(urlset|sitemapindex)\s*>$/i.exec(source.slice(closingStart));
  if (!closing || closing[1]?.toLowerCase() !== opening[1]?.toLowerCase()) return false;
  return !/<\/?(?:urlset|sitemapindex)(?=[\s/>])/i.test(source.slice(openingEnd + 1, closingStart));
}

async function countSitemapEntries(
  sitemapUrl: string,
  userAgent: string,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  try {
    const signal = AbortSignal.timeout(SITEMAP_FETCH_TIMEOUT_MS);
    const res = await fetchImpl(sitemapUrl, {
      method: "GET",
      headers: { "User-Agent": userAgent, Accept: "application/xml, text/xml, */*" },
      signal,
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readBodyCapped(res, SITEMAP_MAX_BYTES, sitemapUrl, signal);
    if (!hasSitemapRoot(text)) return null;
    let count = 0;
    for (const _ of text.matchAll(SITEMAP_LOC_RE)) count += 1;
    return count;
  } catch (e) {
    if (e instanceof EgressBlockedError) throw e;
    logger.warn({
      module: "analyze_scrape_target",
      action: "sitemap_fetch_failed",
      url: sitemapUrl,
      reason: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export const analyzeScrapeTargetTool: ConversationTool = {
  name: "analyze_scrape_target",
  description:
    "Probe a target URL before authoring a web-scraper workflow. Returns a Green / Yellow / Red verdict based on sitemap size and robots.txt, with per-tenant thresholds. Red verdicts refuse to author the recipe; Yellow pauses for operator confirmation; Green is the green-light.",
  inputSchema,
  category: "tenant_read" as const,
  authoring_only: true,
  use_case:
    "Run before `start_workflow_from_recipe` on the `crawl-sitemap-to-markdown` recipe so the authoring loop does not draft against a 100K-page sitemap or a robots-disallowed origin.",
  important_notes: [
    "Honours `connectors.web_scraper.authoring.yellow_sitemap_threshold` and `red_sitemap_threshold` from tenant-effective config.",
    "Robots verification reads at most 512 KiB and sitemap verification at most 8 MiB. Each probe has a 5-second transport/body deadline; overflow or timeout stays unverified and returns Red.",
    "Unavailable robots or sitemap verification returns Red with an unknown count. Missing robots.txt (404/410) permits checking the sitemap.",
  ],
  example_input: {
    target_url: "https://example.com/docs/",
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const cfg = getConfig(ctx.tenant_id).connectors.web_scraper;
    const userAgent = cfg.runtime.user_agent;
    const target = new URL(args.target_url);
    const sitemapUrl = args.sitemap_url ?? `${target.origin}/sitemap.xml`;

    const result: ProbeResult = {
      verdict: "green",
      message: "Target looks scrapable. Authoring may proceed.",
      sitemap_entry_count: null,
      robots_disallowed: false,
      details: { target_url: args.target_url, sitemap_url: sitemapUrl },
    };

    for (const probe of [target, new URL(sitemapUrl)]) {
      try {
        await assertEgressAllowedResolved(probe, { tenant_id: ctx.tenant_id, exec: ctx.db });
      } catch (e) {
        if (e instanceof EgressBlockedError) {
          return {
            ok: true,
            data: {
              ...result,
              verdict: "red",
              message: `Refusing to probe ${probe.toString()} — egress guard blocked the host (${e.reason}). Configure a public origin or contact the operator about the egress policy.`,
              details: { ...result.details, egress_blocked_host: e.host },
            },
          };
        }
        throw e;
      }
    }

    if (cfg.runtime.respect_robots) {
      const robots = await getRobotsVerification({
        tenantId: ctx.tenant_id,
        exec: ctx.db,
        origin: target.origin,
        userAgent,
      });
      if (robots.status === "unavailable") {
        return {
          ok: true,
          data: {
            ...result,
            verdict: "red",
            message: "Cannot verify robots.txt. Retry verification before authoring a scraper.",
            details: { ...result.details, verification_unavailable: "robots" },
          },
        };
      }
      if (robots.parsed?.isAllowed(target.toString(), userAgent) === false) {
        return {
          ok: true,
          data: {
            ...result,
            verdict: "red",
            robots_disallowed: true,
            message: `robots.txt forbids scraping ${target.toString()} for user-agent ${userAgent}. Refuse to author a recipe that respects robots and reaches this URL.`,
          },
        };
      }
    }

    let sitemapCount: number | null;
    try {
      sitemapCount = await countSitemapEntries(
        sitemapUrl,
        userAgent,
        guardedFetch({ tenant_id: ctx.tenant_id, exec: ctx.db }, getDriverFetch()),
      );
    } catch (error) {
      if (!(error instanceof EgressBlockedError)) throw error;
      return {
        ok: true,
        data: {
          ...result,
          verdict: "red",
          message: "Egress policy blocked the sitemap request.",
          details: { ...result.details, egress_blocked_host: error.host },
        },
      };
    }
    if (sitemapCount === null) {
      return {
        ok: true,
        data: {
          ...result,
          verdict: "red",
          message: "Cannot verify the sitemap size. Retry verification before authoring a scraper.",
          details: { ...result.details, verification_unavailable: "sitemap" },
        },
      };
    }
    result.sitemap_entry_count = sitemapCount;

    if (sitemapCount > cfg.authoring.red_sitemap_threshold) {
      return {
        ok: true,
        data: {
          ...result,
          verdict: "red",
          message: `Sitemap has ${sitemapCount} entries (>${cfg.authoring.red_sitemap_threshold}). Recommend: (a) define a path prefix, (b) ingest only the sitemap index, (c) split across multiple connector instances.`,
        },
      };
    }
    if (sitemapCount > cfg.authoring.yellow_sitemap_threshold) {
      return {
        ok: true,
        data: {
          ...result,
          verdict: "yellow",
          message: `Sitemap has ${sitemapCount} entries (>${cfg.authoring.yellow_sitemap_threshold}). Options: (a) restrict to a path prefix, (b) ingest sitemap index only, (c) raise connectors.web_scraper.runtime.max_pages (you'll be charged per page).`,
        },
      };
    }

    return { ok: true, data: result };
  },
};
