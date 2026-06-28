import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Db } from "../../db/client.ts";
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
});
