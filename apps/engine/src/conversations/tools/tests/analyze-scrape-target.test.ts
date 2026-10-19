import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as loader from "../../../config/loader.ts";
import { type Config, ConfigSchema } from "../../../config/schema.ts";
import { _withEgressLookupForTests } from "../../../connectors/egress-guard.ts";
import { __resetRobotsCacheForTests } from "../../../connectors/robots-cache.test-helpers.ts";
import { ROBOTS_MAX_BYTES } from "../../../connectors/robots-cache.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { analyzeScrapeTargetTool, SITEMAP_MAX_BYTES } from "../analyze-scrape-target.ts";
import type { ToolContext } from "../index.ts";

const baseConfig: Config = ConfigSchema.parse({
  database: { url: "postgres://test" },
  egress: { mode: "strict" },
});

let configSpy: ReturnType<typeof spyOn<typeof loader, "getConfig">>;
let fetchSpy: ReturnType<typeof mock<typeof fetch>>;

function installFetch(impl?: typeof fetch): ReturnType<typeof mock<typeof fetch>> {
  return impl ? mock<typeof fetch>(impl) : mock<typeof fetch>();
}

const dispatchFetch = ((...args: Parameters<typeof fetch>) =>
  (fetchSpy as unknown as typeof fetch)(...args)) as typeof fetch;

function seamTest(name: string, body: () => Promise<void>) {
  test(name, () =>
    _withEgressLookupForTests(
      async () => [{ address: "93.184.216.34", family: 4 }],
      () => withSelfHostedDriverFetchForTests(dispatchFetch, body),
    ),
  );
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
  return (async (url: URL | string, init?: RequestInit) => {
    const pinned = new URL(url);
    expect(pinned.hostname).toBe("93.184.216.34");
    const logical = new URL(pinned);
    const host = new Headers(init?.headers).get("host");
    expect(host).toBe("example.com");
    logical.host = host ?? "";
    const r = routes[logical.toString()];
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
  seamTest("sitemap fetch error refuses an unverified target with an unknown count", async () => {
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
    expect(out.data).toMatchObject({
      verdict: "red",
      sitemap_entry_count: null,
      robots_disallowed: false,
      details: { verification_unavailable: "sitemap" },
    });
  });
});

describe("analyze_scrape_target / verification availability", () => {
  for (const status of [404, 410]) {
    seamTest(`missing robots (${status}) permits a verified small sitemap`, async () => {
      fetchSpy = installFetch(
        makeFetch({
          "https://example.com/robots.txt": { status },
          "https://example.com/sitemap.xml": { body: siteMapWith(1) },
        }),
      );
      const out = await analyzeScrapeTargetTool.execute(ctx(), {
        target_url: "https://example.com/",
      });
      expect(out.data).toMatchObject({
        verdict: "green",
        sitemap_entry_count: 1,
        robots_disallowed: false,
      });
    });
  }

  for (const status of [403, 429, 500]) {
    seamTest(
      `unavailable robots (${status}) never yields green or claims a disallow rule`,
      async () => {
        fetchSpy = installFetch(
          makeFetch({
            "https://example.com/robots.txt": { status },
            "https://example.com/sitemap.xml": { body: siteMapWith(1) },
          }),
        );
        const out = await analyzeScrapeTargetTool.execute(ctx(), {
          target_url: "https://example.com/",
        });
        expect(out.data).toMatchObject({
          verdict: "red",
          sitemap_entry_count: null,
          robots_disallowed: false,
          details: { verification_unavailable: "robots" },
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      },
    );
  }

  seamTest("robots network failure remains unknown on a cache hit", async () => {
    fetchSpy = installFetch((async () => {
      throw new Error("fixture robots unavailable");
    }) as unknown as typeof fetch);
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await analyzeScrapeTargetTool.execute(ctx(), {
        target_url: "https://example.com/",
      });
      expect(out.data).toMatchObject({
        verdict: "red",
        sitemap_entry_count: null,
        robots_disallowed: false,
        details: { verification_unavailable: "robots" },
      });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  for (const status of [404, 500]) {
    seamTest(`unavailable sitemap (${status}) is unknown rather than empty`, async () => {
      fetchSpy = installFetch(
        makeFetch({
          "https://example.com/robots.txt": { body: "User-agent: *\nAllow: /" },
          "https://example.com/sitemap.xml": { status },
        }),
      );
      const out = await analyzeScrapeTargetTool.execute(ctx(), {
        target_url: "https://example.com/",
      });
      expect(out.data).toMatchObject({
        verdict: "red",
        sitemap_entry_count: null,
        details: { verification_unavailable: "sitemap" },
      });
    });
  }

  seamTest("a verified empty sitemap still counts as zero", async () => {
    fetchSpy = installFetch(
      makeFetch({
        "https://example.com/robots.txt": { body: "User-agent: *\nAllow: /" },
        "https://example.com/sitemap.xml": { body: siteMapWith(0) },
      }),
    );
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "https://example.com/",
    });
    expect(out.data).toMatchObject({ verdict: "green", sitemap_entry_count: 0 });
  });

  seamTest("a self-closing sitemap root is a verified empty sitemap", async () => {
    fetchSpy = installFetch(
      makeFetch({
        "https://example.com/robots.txt": { status: 404 },
        "https://example.com/sitemap.xml": {
          body: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>',
        },
      }),
    );
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "https://example.com/",
    });
    expect(out.data).toMatchObject({ verdict: "green", sitemap_entry_count: 0 });
  });

  seamTest("an HTML error page served as HTTP 200 is not an empty sitemap", async () => {
    fetchSpy = installFetch(
      makeFetch({
        "https://example.com/robots.txt": { body: "User-agent: *\nAllow: /" },
        "https://example.com/sitemap.xml": { body: "<html><body>unavailable</body></html>" },
      }),
    );
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "https://example.com/",
    });
    expect(out.data).toMatchObject({
      verdict: "red",
      sitemap_entry_count: null,
      details: { verification_unavailable: "sitemap" },
    });
  });
});

describe("analyze_scrape_target / bounded verification bodies", () => {
  for (const probe of ["robots", "sitemap"] as const) {
    for (const declared of [false, true]) {
      seamTest(
        `${probe} oversized stream is cancelled (${declared ? "declared" : "underreported"})`,
        async () => {
          const cap = probe === "robots" ? ROBOTS_MAX_BYTES : SITEMAP_MAX_BYTES;
          let cancelled = false;
          fetchSpy = installFetch((async (url: URL | string) => {
            const isRobots = new URL(url).pathname === "/robots.txt";
            if ((probe === "robots") === isRobots) {
              return new Response(
                new ReadableStream<Uint8Array>({
                  pull(controller) {
                    controller.enqueue(new Uint8Array(64 * 1024).fill(65));
                  },
                  cancel() {
                    cancelled = true;
                  },
                }),
                { headers: { "content-length": declared ? String(cap + 1) : "1" } },
              );
            }
            return new Response(isRobots ? "User-agent: *\nAllow: /" : siteMapWith(1));
          }) as unknown as typeof fetch);
          const out = await analyzeScrapeTargetTool.execute(ctx(), {
            target_url: "https://example.com/",
          });
          expect(out.data).toMatchObject({
            verdict: "red",
            sitemap_entry_count: null,
            robots_disallowed: false,
            details: { verification_unavailable: probe },
          });
          expect(cancelled).toBe(true);
          if (probe === "robots") {
            const repeated = await analyzeScrapeTargetTool.execute(ctx(), {
              target_url: "https://example.com/",
            });
            expect(repeated.data).toMatchObject({
              verdict: "red",
              details: { verification_unavailable: "robots" },
            });
            expect(fetchSpy).toHaveBeenCalledTimes(1);
          }
        },
      );
    }

    seamTest(`${probe} body remains covered by the original transport deadline`, async () => {
      const controller = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      let cancelled = false;
      fetchSpy = installFetch((async (url: URL | string, init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal);
        const isRobots = new URL(url).pathname === "/robots.txt";
        if ((probe === "robots") === isRobots) {
          return new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                queueMicrotask(() =>
                  controller.abort(new DOMException("fixture deadline", "TimeoutError")),
                );
                return new Promise(() => {});
              },
              cancel() {
                cancelled = true;
              },
            }),
          );
        }
        return new Response(isRobots ? "User-agent: *\nAllow: /" : siteMapWith(1));
      }) as unknown as typeof fetch);
      try {
        const out = await analyzeScrapeTargetTool.execute(ctx(), {
          target_url: "https://example.com/",
        });
        expect(out.data).toMatchObject({
          verdict: "red",
          sitemap_entry_count: null,
          details: { verification_unavailable: probe },
        });
        expect(cancelled).toBe(true);
      } finally {
        timeout.mockRestore();
      }
    });
  }

  seamTest("many malformed root openings are rejected as unverified", async () => {
    fetchSpy = installFetch(
      makeFetch({
        "https://example.com/robots.txt": { status: 404 },
        "https://example.com/sitemap.xml": { body: "<urlset>".repeat(32768) },
      }),
    );
    const out = await analyzeScrapeTargetTool.execute(ctx(), {
      target_url: "https://example.com/",
    });
    expect(out.data).toMatchObject({
      verdict: "red",
      sitemap_entry_count: null,
      details: { verification_unavailable: "sitemap" },
    });
  });
});
