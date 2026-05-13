// analyze_scrape_target — web-scraper #144 pre-flight authoring gate.
//
// The chat surface calls this tool BEFORE drafting a `crawl-sitemap-to-
// markdown` workflow. The tool probes the target origin and returns a
// Green / Yellow / Red verdict so the authoring loop refuses obviously
// unscrapable scopes (sitemap > red_sitemap_threshold, robots.txt
// disallows the path) and pauses on borderline scopes (sitemap >
// yellow_sitemap_threshold).
//
// Thresholds are tenant-effective config under
// `connectors.web_scraper.authoring.*` — operators override per tenant.

import { z } from "@hono/zod-openapi";

import { getConfig } from "../../config/loader.ts";
import { assertRobotsAllowed, RobotsDisallowedError } from "../../connectors/egress-guard.ts";
import { logger } from "../../logging/logger.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    target_url: z.string().url(),
    /** Defaults to `${origin}/sitemap.xml` when omitted. */
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

async function countSitemapEntries(
  sitemapUrl: string,
  userAgent: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  try {
    const res = await fetchImpl(sitemapUrl, {
      method: "GET",
      headers: { "User-Agent": userAgent, Accept: "application/xml, text/xml, */*" },
    });
    if (!res.ok) return 0;
    const text = await res.text();
    // Cheap regex count avoids pulling a full XML parser into the chat
    // tool — every <loc>…</loc> is one URL. Index-only sitemaps still
    // count (they pin a Yellow/Red gate at the index level too).
    let count = 0;
    for (const _ of text.matchAll(SITEMAP_LOC_RE)) count += 1;
    return count;
  } catch (e) {
    logger.warn({
      module: "analyze_scrape_target",
      action: "sitemap_fetch_failed",
      url: sitemapUrl,
      reason: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}

export const analyzeScrapeTargetTool: ConversationTool = {
  name: "analyze_scrape_target",
  description:
    "Probe a target URL before authoring a web-scraper workflow. Returns a Green / Yellow / Red verdict based on sitemap size and robots.txt, with per-tenant thresholds. Red verdicts refuse to author the recipe; Yellow pauses for operator confirmation; Green is the green-light.",
  inputSchema,
  category: "tenant_read" as const,
  use_case:
    "Run before `start_workflow_from_recipe` on the `crawl-sitemap-to-markdown` recipe so the authoring loop does not draft against a 100K-page sitemap or a robots-disallowed origin.",
  important_notes: [
    "Honours `connectors.web_scraper.authoring.yellow_sitemap_threshold` and `red_sitemap_threshold` from tenant-effective config.",
    "Treats network errors on sitemap.xml as `sitemap_entry_count: 0` — the verdict falls through to Green based on robots alone.",
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

    // robots.txt — Red if disallow on the path. Honours tenant
    // respect_robots; when respect_robots=false we skip and Green-light.
    if (cfg.runtime.respect_robots) {
      try {
        await assertRobotsAllowed(target, {
          tenant_id: ctx.tenant_id,
          userAgent,
        });
      } catch (e) {
        if (e instanceof RobotsDisallowedError) {
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
        // Network failures on robots.txt are non-fatal — assertRobotsAllowed
        // already logs them; we proceed to the sitemap check.
      }
    }

    const sitemapCount = await countSitemapEntries(sitemapUrl, userAgent, globalThis.fetch);
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
