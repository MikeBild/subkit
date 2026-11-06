import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as loader from "../config/loader.ts";
import { type Config, ConfigSchema } from "../config/schema.ts";
import type { Executor } from "../db/client.ts";
import { _withEgressLookupForTests, _withEgressTenantOriginForTests } from "./egress-guard.ts";
import {
  __getRobotsCacheStatsForTests,
  __resetRobotsCacheForTests,
} from "./robots-cache.test-helpers.ts";
import { getRobots as readRobots } from "./robots-cache.ts";

const originOverrideExec = {} as Executor;

function getRobots(params: Omit<Parameters<typeof readRobots>[0], "exec">) {
  return _withEgressTenantOriginForTests(
    async () => "self_hosted",
    () => readRobots({ ...params, exec: originOverrideExec }),
  );
}

const baseConfig: Config = ConfigSchema.parse({
  database: { url: "postgres://test" },
});

let configSpy: ReturnType<typeof spyOn<typeof loader, "getConfig">>;

beforeAll(() => {
  configSpy = spyOn(loader, "getConfig").mockReturnValue(baseConfig);
});
afterAll(() => {
  configSpy.mockRestore();
});
beforeEach(() => {
  __resetRobotsCacheForTests();
  configSpy.mockReturnValue(baseConfig);
});

function makeFetch(bodyByUrl: Record<string, { status?: number; body?: string }>): typeof fetch {
  return (async (url: URL | string) => {
    const u = typeof url === "string" ? url : url.toString();
    const cfg = bodyByUrl[u];
    if (!cfg) return new Response("", { status: 404 });
    return new Response(cfg.body ?? "", { status: cfg.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe("robots-cache / parsing", () => {
  test("Disallow on a path is enforced for the configured UA", async () => {
    const robots = await getRobots({
      tenantId: "tenant-a",
      origin: "https://example.com",
      userAgent: "sk-web-scraper/1.0",
      fetchImpl: makeFetch({
        "https://example.com/robots.txt": {
          body: "User-agent: *\nDisallow: /private",
        },
      }),
    });
    expect(robots).not.toBeNull();
    expect(robots?.isAllowed("https://example.com/public", "sk-web-scraper/1.0")).toBe(true);
    expect(robots?.isAllowed("https://example.com/private", "sk-web-scraper/1.0")).toBe(false);
  });

  test("missing robots.txt is treated as allow-all (returns null)", async () => {
    const robots = await getRobots({
      tenantId: "tenant-a",
      origin: "https://example.com",
      userAgent: "sk-web-scraper/1.0",
      fetchImpl: makeFetch({}),
    });
    expect(robots).toBeNull();
  });

  test("user-agent specific rule overrides wildcard", async () => {
    const robots = await getRobots({
      tenantId: "tenant-a",
      origin: "https://example.com",
      userAgent: "sk-web-scraper",
      fetchImpl: makeFetch({
        "https://example.com/robots.txt": {
          body: "User-agent: *\nAllow: /\n\nUser-agent: sk-web-scraper\nDisallow: /forbidden",
        },
      }),
    });
    expect(robots?.isAllowed("https://example.com/forbidden", "sk-web-scraper")).toBe(false);
    expect(robots?.isAllowed("https://example.com/forbidden", "other-bot")).toBe(true);
  });
});

describe("robots-cache / tenant isolation", () => {
  test("tenant A and tenant B keep separate cache entries", async () => {
    let aFetches = 0;
    let bFetches = 0;
    const fetchA: typeof fetch = (async () => {
      aFetches += 1;
      return new Response("User-agent: *\nDisallow: /a-only", { status: 200 });
    }) as unknown as typeof fetch;
    const fetchB: typeof fetch = (async () => {
      bFetches += 1;
      return new Response("User-agent: *\nAllow: /", { status: 200 });
    }) as unknown as typeof fetch;

    await getRobots({
      tenantId: "tenant-a",
      origin: "https://shared.example.com",
      userAgent: "ua",
      fetchImpl: fetchA,
    });
    await getRobots({
      tenantId: "tenant-b",
      origin: "https://shared.example.com",
      userAgent: "ua",
      fetchImpl: fetchB,
    });

    expect(aFetches).toBe(1);
    expect(bFetches).toBe(1);
    expect(__getRobotsCacheStatsForTests().size).toBe(2);

    await getRobots({
      tenantId: "tenant-a",
      origin: "https://shared.example.com",
      userAgent: "ua",
      fetchImpl: fetchA,
    });
    expect(aFetches).toBe(1);
  });
});

describe("robots-cache / TTL", () => {
  test("expired entry triggers a refetch", async () => {
    let fetches = 0;
    const f: typeof fetch = (async () => {
      fetches += 1;
      return new Response("User-agent: *\nAllow: /", { status: 200 });
    }) as unknown as typeof fetch;

    const shortTtl: Config = {
      ...baseConfig,
      connectors: {
        ...baseConfig.connectors,
        web_scraper: {
          ...baseConfig.connectors.web_scraper,
          robots_cache: {
            ttl_ms: 60_000,
            max_entries: 2_000,
          },
        },
      },
    };
    configSpy.mockReturnValue(shortTtl);

    await getRobots({
      tenantId: "tenant-c",
      origin: "https://example.org",
      userAgent: "ua",
      fetchImpl: f,
    });
    expect(fetches).toBe(1);

    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 120_000;
      await getRobots({
        tenantId: "tenant-c",
        origin: "https://example.org",
        userAgent: "ua",
        fetchImpl: f,
      });
    } finally {
      Date.now = originalNow;
    }
    expect(fetches).toBe(2);
  });
});

describe("hosted robots transport", () => {
  test("a hostname resolving to a private address never reaches the transport", async () => {
    let calls = 0;
    const fetchImpl = Object.assign(
      async () => {
        calls++;
        return new Response("");
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    await _withEgressTenantOriginForTests(
      async () => "self_service",
      () =>
        _withEgressLookupForTests(
          async () => [{ address: "127.0.0.1", family: 4 }],
          async () => {
            expect(
              await readRobots({
                tenantId: "hosted-tenant",
                exec: originOverrideExec,
                origin: "https://robots.example.test",
                userAgent: "fixture",
                fetchImpl,
              }),
            ).toBeNull();
          },
        ),
    );
    expect(calls).toBe(0);
  });

  test("a public robots redirect to a private target never sends the second request", async () => {
    let calls = 0;
    const fetchImpl = Object.assign(
      async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/private" },
        });
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    await _withEgressTenantOriginForTests(
      async () => "self_service",
      () =>
        _withEgressLookupForTests(
          async () => [{ address: "8.8.8.8", family: 4 }],
          async () => {
            expect(
              await readRobots({
                tenantId: "hosted-tenant",
                exec: originOverrideExec,
                origin: "https://robots.example.test",
                userAgent: "fixture",
                fetchImpl,
              }),
            ).toBeNull();
          },
        ),
    );
    expect(calls).toBe(1);
  });
});
