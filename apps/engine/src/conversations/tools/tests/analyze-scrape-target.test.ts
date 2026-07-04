// Unit tests for the analyze_scrape_target chat tool.
//
// What's covered:
//   - Green verdict when sitemap is under thresholds and robots allows
//   - Yellow / Red verdicts at the documented sitemap entry thresholds
//   - Red on a robots-disallowed path
//   - Red (SSRF refusal) on a private-IP / metadata-service target
//   - Sitemap fetch timeout falls through to Green (count = 0)
//   - Tool stays in `tenant_read` category and reads tunables from
//     getConfig(tenant_id).connectors.web_scraper.authoring.*

import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as loader from "../../../config/loader.ts";
import { type Config, ConfigSchema } from "../../../config/schema.ts";
import { __resetRobotsCacheForTests } from "../../../connectors/robots-cache.test-helpers.ts";
import { withDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { analyzeScrapeTargetTool } from "../analyze-scrape-target.ts";
import type { ToolContext } from "../index.ts";

// Use strict egress mode so the SSRF tests exercise the RFC 1918 /
// metadata-service guards; permissive (the dev default) only blocks
// bare localhost / 0.0.0.0.
const baseConfig: Config = ConfigSchema.parse({
  database: { url: "postgres://test" },
  egress: { mode: "strict" },
});

let configSpy: ReturnType<typeof spyOn<typeof loader, "getConfig">>;
let fetchSpy: ReturnType<typeof mock<typeof fetch>>;

/** Driver-fetch seam: the tool and robots-cache read getDriverFetch(),
 *  not globalThis. The seam override must wrap the body explicitly
 *  (store.run via `withDriverFetchForTests`), but each test picks its
 *  fetch impl INSIDE the body — so `seamTest` binds a stable dispatcher
 *  that forwards to whatever `fetchSpy` currently is. */
function installFetch(impl?: typeof fetch): ReturnType<typeof mock<typeof fetch>> {
  return impl ? mock<typeof fetch>(impl) : mock<typeof fetch>();
}

const dispatchFetch = ((...args: Parameters<typeof fetch>) =>
  (fetchSpy as unknown as typeof fetch)(...args)) as typeof fetch;

function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withDriverFetchForTests(dispatchFetch, body));
}

function ctx(): ToolContext {
  return { tenant_id: "00000000-0000-0000-0000-000000000001" } as unknown as ToolContext;
}

function siteMapWith(count: number): string {
  let body = '<?xml version="1.0"?><urlset>';
  for (let i = 0; i < count; i += 1) body += `<url><loc>https://example.com/p/${i}</loc></url>`;
  body += "</urlset>";
  return body;
}

function makeFetch(routes: Record<string, { status?: number; body?: string }>): typeof fetch {
  return (async (url: URL | string) => {
    const u = typeof url === "string" ? url : url.toString();
    const r = routes[u];
    if (!r) return new Response("", { status: 404 });
    return new Response(r.body ?? "", { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
}

beforeAll(() => {
  configSpy = spyOn(loader, "getConfig").mockReturnValue(baseConfig);
});
afterAll(() => {
  configSpy.mockRestore();
});
beforeEach(() => {
  __resetRobotsCacheForTests();
  configSpy.mockReturnValue(baseConfig);
  fetchSpy = mock<typeof fetch>();
});

describe("analyze_scrape_target / registration", () => {
  test("registers as tenant_read with a stable name", () => {
    expect(analyzeScrapeTargetTool.name).toBe("analyze_scrape_target");
    expect(analyzeScrapeTargetTool.category).toBe("tenant_read");
  });

  seamTest("rejects malformed target_url at schema level", async () => {
    await expect(
      analyzeScrapeTargetTool.execute(ctx(), { target_url: "not-a-url" }),
    ).rejects.toThrow();
  });
});

describe("analyze_scrape_target / verdicts", () => {
  seamTest("green when robots allows and sitemap is small", async () => {
    fetchSpy = installFetch(
      makeFetch({
        "https://example.com/robots.txt": { body: "User-agent: *\nAllow: /" },
        "https://example.com/sitemap.xml": { body: siteMapWith(10) },
      }),
    );
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "https://example.com/docs/",
    });
    expect(out.ok).toBe(true);
    expect((out.data as { verdict: string }).verdict).toBe("green");
    expect((out.data as { sitemap_entry_count: number }).sitemap_entry_count).toBe(10);
  });

  seamTest("yellow when sitemap count exceeds yellow_sitemap_threshold", async () => {
    fetchSpy = installFetch(
      makeFetch({
        "https://example.com/robots.txt": { body: "User-agent: *\nAllow: /" },
        "https://example.com/sitemap.xml": { body: siteMapWith(15_000) },
      }),
    );
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "https://example.com/docs/",
    });
    expect((out.data as { verdict: string }).verdict).toBe("yellow");
    expect((out.data as { sitemap_entry_count: number }).sitemap_entry_count).toBe(15_000);
  });

  seamTest("red when sitemap count exceeds red_sitemap_threshold", async () => {
    // Building 100_001 url tags inline is wasteful — instead patch the
    // config so a 1000-entry sitemap trips the red gate.
    const tight: Config = {
      ...baseConfig,
      connectors: {
        ...baseConfig.connectors,
        web_scraper: {
          ...baseConfig.connectors.web_scraper,
          authoring: {
            ...baseConfig.connectors.web_scraper.authoring,
            yellow_sitemap_threshold: 100,
            red_sitemap_threshold: 500,
          },
        },
      },
    };
    configSpy.mockReturnValue(tight);
    fetchSpy = installFetch(
      makeFetch({
        "https://example.com/robots.txt": { body: "User-agent: *\nAllow: /" },
        "https://example.com/sitemap.xml": { body: siteMapWith(1_000) },
      }),
    );
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "https://example.com/docs/",
    });
    expect((out.data as { verdict: string }).verdict).toBe("red");
  });

  seamTest("red when robots.txt disallows the target path", async () => {
    fetchSpy = installFetch(
      makeFetch({
        "https://example.com/robots.txt": {
          body: "User-agent: *\nDisallow: /docs/",
        },
      }),
    );
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "https://example.com/docs/private",
    });
    expect((out.data as { verdict: string }).verdict).toBe("red");
    expect((out.data as { robots_disallowed: boolean }).robots_disallowed).toBe(true);
  });
});

describe("analyze_scrape_target / SSRF guard", () => {
  seamTest("refuses a target on the AWS metadata service", async () => {
    fetchSpy = installFetch();
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(out.ok).toBe(true);
    expect((out.data as { verdict: string }).verdict).toBe("red");
    expect((out.data as { message: string }).message).toMatch(/egress guard blocked/i);
    // SSRF guard runs BEFORE any fetch — no outbound call must reach
    // the network.
    expect(fetchSpy.mock.calls.length).toBe(0);
  });

  seamTest("refuses a target on localhost (production-strict default)", async () => {
    fetchSpy = installFetch();
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "http://localhost:5432/",
    });
    expect((out.data as { verdict: string }).verdict).toBe("red");
    expect(fetchSpy.mock.calls.length).toBe(0);
  });

  seamTest("refuses an RFC 1918 sitemap URL even when target is public", async () => {
    fetchSpy = installFetch();
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "https://example.com/docs/",
      sitemap_url: "http://10.0.0.1/sitemap.xml",
    });
    expect((out.data as { verdict: string }).verdict).toBe("red");
    expect(fetchSpy.mock.calls.length).toBe(0);
  });
});

describe("analyze_scrape_target / fetch tolerance", () => {
  seamTest("sitemap fetch error → count 0 → green", async () => {
    fetchSpy = installFetch((async (url: URL | string) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /", { status: 200 });
      }
      throw new Error("simulated network failure");
    }) as unknown as typeof fetch);
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "https://example.com/",
    });
    expect((out.data as { verdict: string }).verdict).toBe("green");
    expect((out.data as { sitemap_entry_count: number }).sitemap_entry_count).toBe(0);
  });
});
