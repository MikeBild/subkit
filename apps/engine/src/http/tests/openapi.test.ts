import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("openapi");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("openapi", () => {
  test("/openapi.json returns a valid spec", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, { type: string; scheme: string }> };
    };
    expect(spec.info.title).toBe("subkit engine");
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth?.type).toBe("http");
    expect(spec.components.securitySchemes.bearerAuth?.scheme).toBe("bearer");
  });

  test("/docs serves Scalar HTML", async () => {
    const res = await fetch(`${ctx.baseUrl}/docs`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("api-reference");
    expect(text).toContain("/openapi.json");
  });
});
