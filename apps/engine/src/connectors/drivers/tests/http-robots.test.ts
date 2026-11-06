import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { withDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { configureHostedPolicyForTests } from "../../../test-helpers/hosted-policy.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { __resetRobotsCacheForTests } from "../../robots-cache.test-helpers.ts";
import { createConnector, getConnector } from "../../service.ts";
import { executeConnectorHttpRequest } from "../http.ts";

let database: TestDb;
let tenantId: string;

beforeAll(async () => {
  database = await createTestDb("http-robots");
  await configureHostedPolicyForTests(database.db, database.url);
  const tenant = await seedTenant(database.db, {
    slug: "runtime-robots",
    display_name: "Runtime robots fixture",
  });
  tenantId = tenant.id;
});
afterAll(async () => {
  await database?.cleanup();
});

for (const status of [503, 429, "network"] as const) {
  test(`runtime refuses unavailable robots (${status}) including a cached result`, async () => {
    __resetRobotsCacheForTests();
    let robotsRequests = 0;
    let resourceRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/robots.txt") {
          robotsRequests++;
          return new Response("unavailable", { status: status === "network" ? 503 : status });
        }
        resourceRequests++;
        return Response.json({ ok: true });
      },
    });
    try {
      const saved = await createConnector(
        {
          tenant_id: tenantId,
          actor_id: null,
          input: {
            name: `runtime-robots-${status}`,
            template_slug: "web-scraper",
            driver: "http",
            auth_type: "none",
            environment: "dev",
            base_url: `http://127.0.0.1:${server.port}`,
          },
        },
        database.db,
      );
      const connector = await getConnector(tenantId, saved.id, database.db);
      if (!connector) throw new Error("missing robots fixture connector");
      for (let attempt = 0; attempt < 2; attempt++) {
        const run = () =>
          executeConnectorHttpRequest({
            db: database.db,
            tenant_id: tenantId,
            connector,
            method: "GET",
            path_or_url: "/docs",
          });
        const failingNetwork: typeof fetch = Object.assign(
          async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (new URL(url instanceof Request ? url.url : url).pathname === "/robots.txt") {
              robotsRequests++;
              throw new Error("fixture robots network unavailable");
            }
            return fetch(url, init);
          },
          { preconnect: () => {} },
        );
        await expect(
          status === "network" ? withDriverFetchForTests(failingNetwork, run) : run(),
        ).rejects.toMatchObject({ code: "robots_verification_unavailable" });
      }
      expect(robotsRequests).toBe(1);
      expect(resourceRequests).toBe(0);
      const ignored = await executeConnectorHttpRequest({
        db: database.db,
        tenant_id: tenantId,
        connector: { ...connector, config: { ...connector.config, respect_robots: false } },
        method: "GET",
        path_or_url: "/docs",
      });
      expect(ignored.status).toBe(200);
      expect(resourceRequests).toBe(1);
      expect(robotsRequests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });
}

for (const status of [404, 410, 200]) {
  test(`runtime permits verified allow rules or absent robots (${status})`, async () => {
    __resetRobotsCacheForTests();
    let resourceRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/robots.txt")
          return new Response("User-agent: *\nAllow: /", { status });
        resourceRequests++;
        return Response.json({ ok: true });
      },
    });
    try {
      const connector = await createConnector(
        {
          tenant_id: tenantId,
          actor_id: null,
          input: {
            name: `runtime-robots-allowed-${status}`,
            template_slug: "web-scraper",
            driver: "http",
            auth_type: "none",
            environment: "dev",
            base_url: `http://127.0.0.1:${server.port}`,
          },
        },
        database.db,
      );
      const result = await executeConnectorHttpRequest({
        db: database.db,
        tenant_id: tenantId,
        connector,
        method: "GET",
        path_or_url: "/docs",
      });
      expect(result.status).toBe(200);
      expect(resourceRequests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });
}

test("runtime enforces a verified robots disallow rule", async () => {
  __resetRobotsCacheForTests();
  let resourceRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/robots.txt")
        return new Response("User-agent: *\nDisallow: /docs");
      resourceRequests++;
      return Response.json({ ok: true });
    },
  });
  try {
    const connector = await createConnector(
      {
        tenant_id: tenantId,
        actor_id: null,
        input: {
          name: "runtime-robots-disallowed",
          template_slug: "web-scraper",
          driver: "http",
          auth_type: "none",
          environment: "dev",
          base_url: `http://127.0.0.1:${server.port}`,
        },
      },
      database.db,
    );
    await expect(
      executeConnectorHttpRequest({
        db: database.db,
        tenant_id: tenantId,
        connector,
        method: "GET",
        path_or_url: "/docs",
      }),
    ).rejects.toMatchObject({ code: "robots_disallowed" });
    expect(resourceRequests).toBe(0);
  } finally {
    await server.stop(true);
  }
});
