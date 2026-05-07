import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("health");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /v1/health", () => {
  test("returns 200 with db_connected=true and db_schema_drift=false on a fresh DB", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      version: string;
      db_connected: boolean;
      db_schema_drift: boolean;
      uptime_seconds: number;
    };
    expect(body.status).toBe("ok");
    expect(body.db_connected).toBe(true);
    // Issue #149 — locks the new field's contract so a regression that
    // drops the flag (e.g. trims OpenAPI surface) fails here.
    expect(typeof body.db_schema_drift).toBe("boolean");
    expect(body.db_schema_drift).toBe(false);
    expect(typeof body.uptime_seconds).toBe("number");
    expect(res.headers.get("x-trace-id")).toBeTruthy();
  });
});
