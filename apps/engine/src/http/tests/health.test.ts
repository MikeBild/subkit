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
  test("returns 200 with db_connected=true", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      version: string;
      db_connected: boolean;
      uptime_seconds: number;
    };
    expect(body.status).toBe("ok");
    expect(body.db_connected).toBe(true);
    expect(typeof body.uptime_seconds).toBe("number");
    expect(res.headers.get("x-trace-id")).toBeTruthy();
  });
});
