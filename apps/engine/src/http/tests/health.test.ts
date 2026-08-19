import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Db } from "../../db/client.ts";
import { setHealthState } from "../health-state.ts";
import type { AppEnv } from "../openapi.ts";
import { registerHealthRoute } from "../routes/health.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("health");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /v1/health", () => {
  test("returns 200 with the minimal liveness shape", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.db_connected).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(res.headers.get("x-trace-id")).toBeTruthy();

    // Lock the wire shape: any extra key is a regression that puts an
    // operational-posture field back on the public surface.
    expect(Object.keys(body).sort()).toEqual([
      "db_connected",
      "status",
      "uptime_seconds",
      "version",
    ]);
  });

  test("does not leak schema-drift, update-availability, or latest-version", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect("db_schema_drift" in body).toBe(false);
    expect("update_available" in body).toBe(false);
    expect("latest_version" in body).toBe(false);
  });
});

describe("GET /docs", () => {
  test("sends a Content-Security-Policy scoping scripts to self + the Scalar CDN", async () => {
    const res = await fetch(`${ctx.baseUrl}/docs`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self' https://cdn.jsdelivr.net");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("GET /v1/readyz", () => {
  test("returns 200 ready when the database is reachable", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ready");
    expect(body.db_connected).toBe(true);
  });

  test("returns 503 unavailable when the database ping fails", async () => {
    // Inject a db whose execute() throws so pingDb resolves false — the
    // readiness probe must surface that as 503, unlike liveness /health.
    const throwingDb = {
      execute: async () => {
        throw new Error("db down");
      },
    } as unknown as Db;
    const app = new OpenAPIHono<AppEnv>();
    registerHealthRoute(app, { db: throwingDb });
    const res = await app.request("http://127.0.0.1/v1/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("unavailable");
    expect(body.db_connected).toBe(false);
  });

  test("returns 503 unavailable while draining, even with the database reachable", async () => {
    // Graceful shutdown flips setHealthState({ draining: true }) BEFORE the
    // HTTP server closes so the load balancer / systemd gate stops routing
    // here while in-flight conversation turns drain. readyz must report that
    // as not-ready even though the DB is fine. Reset in finally so the shared
    // module-scoped health-state singleton can't leak into other tests.
    const okDb = { execute: async () => undefined } as unknown as Db;
    const app = new OpenAPIHono<AppEnv>();
    registerHealthRoute(app, { db: okDb });
    setHealthState({ draining: true });
    try {
      const res = await app.request("http://127.0.0.1/v1/readyz");
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("unavailable");
      // db_connected stays true — not-ready here is due to draining, not the DB.
      expect(body.db_connected).toBe(true);
    } finally {
      setHealthState({ draining: false });
    }
  });
});

describe("unversioned probe aliases", () => {
  test("GET /health is byte-for-byte the /v1/health payload", async () => {
    const [versioned, alias] = await Promise.all([
      fetch(`${ctx.baseUrl}/v1/health`),
      fetch(`${ctx.baseUrl}/health`),
    ]);
    expect(alias.status).toBe(200);
    expect(alias.status).toBe(versioned.status);
    const aliasBody = (await alias.json()) as Record<string, unknown>;
    const versionedBody = (await versioned.json()) as Record<string, unknown>;
    // uptime_seconds advances between the two requests; everything else is
    // the same wire shape and the same values.
    expect(Object.keys(aliasBody).sort()).toEqual(Object.keys(versionedBody).sort());
    expect(aliasBody.status).toBe(versionedBody.status);
    expect(aliasBody.version).toBe(versionedBody.version);
    expect(aliasBody.db_connected).toBe(versionedBody.db_connected);
    expect(typeof aliasBody.uptime_seconds).toBe("number");
  });

  test("GET /ready answers the readiness probe, not liveness", async () => {
    const res = await fetch(`${ctx.baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ready");
    expect(body.db_connected).toBe(true);
  });

  test("both aliases answer without an authorization header", async () => {
    for (const path of ["/health", "/ready"]) {
      const res = await fetch(`${ctx.baseUrl}${path}`);
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  test("GET /ready returns 503 when the database ping fails", async () => {
    const throwingDb = {
      execute: async () => {
        throw new Error("db down");
      },
    } as unknown as Db;
    const app = new OpenAPIHono<AppEnv>();
    registerHealthRoute(app, { db: throwingDb });
    const res = await app.request("http://127.0.0.1/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("unavailable");
    expect(body.db_connected).toBe(false);
  });

  test("GET /ready returns 503 while draining", async () => {
    const okDb = { execute: async () => undefined } as unknown as Db;
    const app = new OpenAPIHono<AppEnv>();
    registerHealthRoute(app, { db: okDb });
    setHealthState({ draining: true });
    try {
      const res = await app.request("http://127.0.0.1/ready");
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("unavailable");
      expect(body.db_connected).toBe(true);
    } finally {
      setHealthState({ draining: false });
    }
  });

  test("the aliases stay out of the published OpenAPI document", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/v1/health");
    expect(Object.keys(doc.paths)).toContain("/v1/readyz");
    expect(Object.keys(doc.paths)).not.toContain("/health");
    expect(Object.keys(doc.paths)).not.toContain("/ready");
  });
});
