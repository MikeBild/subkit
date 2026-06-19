// analyze_scrape_target — web-scraper pre-flight authoring gate.
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
import { getDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
import {
  assertEgressAllowed,
  assertRobotsAllowed,
  EgressBlockedError,
  RobotsDisallowedError,
} from "../../connectors/egress-guard.ts";
import { logger } from "../../logging/logger.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

/** Hard cap on the sitemap probe so a slow-loris origin can't stall
 *  the chat tool. A timeout falls through to `count = 0`, which the
 *  caller treats as "sitemap empty" → Green verdict path. */
const SITEMAP_FETCH_TIMEOUT_MS = 5_000;

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
      signal: AbortSignal.timeout(SITEMAP_FETCH_TIMEOUT_MS),
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

    // SSRF guard runs FIRST — before robots.txt, before sitemap. A
    // tenant-supplied URL pointing at 169.254.169.254 / localhost /
    // RFC 1918 is rejected at the gate and the tool returns a Red
    // verdict with the same shape as a robots-disallowed refusal. The
    // existing `assertEgressAllowed` is the only SSRF policy in the
    // codebase; this surface MUST go through it just like every other
    // outbound site (drivers/http.ts, webhooks/outbound, etc.).
    for (const probe of [target, new URL(sitemapUrl)]) {
      try {
        assertEgressAllowed(probe, { tenant_id: ctx.tenant_id });
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

    const sitemapCount = await countSitemapEntries(sitemapUrl, userAgent, getDriverFetch());
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
