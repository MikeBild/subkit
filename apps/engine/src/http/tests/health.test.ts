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

describe("GET /health", () => {
  test("returns the exact family liveness document", async () => {
    const res = await fetch(`${ctx.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-trace-id")).toBeTruthy();
    expect(await res.json()).toEqual({
      status: "ok",
      service: "subkit",
      version: expect.any(String),
    });
  });

  test("does not access the database", async () => {
    let calls = 0;
    const db = {
      execute: async () => {
        calls += 1;
        throw new Error("db down");
      },
    } as unknown as Db;
    const app = new OpenAPIHono<AppEnv>();
    registerHealthRoute(app, { db });
    const res = await app.request("http://127.0.0.1/health");
    expect(res.status).toBe(200);
    expect(calls).toBe(0);
  });

  test("stays live while draining", async () => {
    const app = new OpenAPIHono<AppEnv>();
    registerHealthRoute(app, { db: { execute: async () => undefined } as unknown as Db });
    setHealthState({ draining: true });
    try {
      const res = await app.request("http://127.0.0.1/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok" });
    } finally {
      setHealthState({ draining: false });
    }
  });
});

describe("GET /ready", () => {
  test("returns 200 only when all critical checks pass", async () => {
    const res = await fetch(`${ctx.baseUrl}/ready`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      status: "ready",
      service: "subkit",
      version: expect.any(String),
      checks: { lifecycle: "pass", database: "pass" },
    });
  });

  test("returns a consistent 503 document when the database ping fails", async () => {
    const db = { execute: async () => Promise.reject(new Error("db down")) } as unknown as Db;
    const app = new OpenAPIHono<AppEnv>();
    registerHealthRoute(app, { db });
    const res = await app.request("http://127.0.0.1/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "not_ready",
      service: "subkit",
      version: expect.any(String),
      checks: { lifecycle: "pass", database: "fail" },
    });
  });

  test("returns a consistent 503 document while draining", async () => {
    const db = { execute: async () => undefined } as unknown as Db;
    const app = new OpenAPIHono<AppEnv>();
    registerHealthRoute(app, { db });
    setHealthState({ draining: true });
    try {
      const res = await app.request("http://127.0.0.1/ready");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: "not_ready",
        service: "subkit",
        version: expect.any(String),
        checks: { lifecycle: "fail", database: "pass" },
      });
    } finally {
      setHealthState({ draining: false });
    }
  });

  test("both probes are public and canonical in OpenAPI", async () => {
    for (const path of ["/health", "/ready"]) {
      const res = await fetch(`${ctx.baseUrl}${path}`);
      expect(res.status).toBe(200);
    }
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        {
          get: {
            summary?: string;
            security?: unknown;
            responses: Record<
              string,
              { headers?: Record<string, { schema?: { enum?: string[] } }> }
            >;
          };
        }
      >;
      components: {
        schemas: Record<
          string,
          { additionalProperties?: boolean; properties?: Record<string, unknown> }
        >;
      };
    };
    expect(Object.keys(doc.paths)).toContain("/health");
    expect(Object.keys(doc.paths)).toContain("/ready");
    expect(doc.paths["/v1/health"]?.get.summary).toBe(
      "Readiness of the product assistant workflow",
    );
    expect(doc.paths["/v1/health"]?.get.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(doc.paths)).not.toContain("/v1/readyz");
    for (const [path, statuses] of [
      ["/health", ["200"]],
      ["/ready", ["200", "503"]],
    ] as const) {
      for (const status of statuses) {
        expect(
          doc.paths[path]!.get.responses[status]!.headers?.["Cache-Control"]?.schema?.enum,
        ).toEqual(["no-store"]);
      }
    }
    expect(doc.components.schemas.HealthResponse?.additionalProperties).toBe(false);
    expect(doc.components.schemas.ReadyResponse?.additionalProperties).toBe(false);
    expect(
      (
        doc.components.schemas.ReadyResponse?.properties?.checks as
          | { additionalProperties?: boolean }
          | undefined
      )?.additionalProperties,
    ).toBe(false);
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
