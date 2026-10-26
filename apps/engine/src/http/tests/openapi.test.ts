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
      components: {
        securitySchemes: Record<
          string,
          { type: string; scheme?: string; flows?: Record<string, unknown> }
        >;
      };
    };
    expect(spec.info.title).toBe("subkit engine");
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth?.type).toBe("http");
    expect(spec.components.securitySchemes.bearerAuth?.scheme).toBe("bearer");
    expect(spec.components.securitySchemes.oauth2?.type).toBe("oauth2");
    expect(spec.components.securitySchemes.oauth2?.flows?.authorizationCode).toBeDefined();
  });

  test("/docs serves Scalar HTML", async () => {
    const res = await fetch(`${ctx.baseUrl}/docs`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("api-reference");
    expect(text).toContain("/openapi.json");
  });

  test("openapi exposes ExecutionRunResponse with request_meta and connector_resolutions", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    const spec = (await res.json()) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    const runResp = spec.components.schemas.ExecutionRunResponse as {
      properties: Record<string, unknown>;
    };
    expect(runResp).toBeDefined();
    expect(runResp.properties.steps).toBeDefined();
    expect(runResp.properties.connector_resolutions).toBeDefined();
    expect(spec.components.schemas.ConnectorResolutionSummary).toBeDefined();
    expect(spec.components.schemas.ExecutionRunStepSummary).toBeDefined();
  });

  test("openapi carries only workflow AutomationReadiness and no legacy automation paths", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    const spec = (await res.json()) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(
      Object.keys(spec.components.schemas).filter((name) => name.startsWith("Automation")),
    ).toEqual(["AutomationReadiness"]);
    expect(Object.keys(spec.paths).filter((path) => path.startsWith("/v1/automations"))).toEqual(
      [],
    );
  });
});
