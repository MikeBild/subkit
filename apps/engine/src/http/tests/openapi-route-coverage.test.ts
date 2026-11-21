import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("openapi-route-coverage");
});

afterAll(async () => {
  await ctx.cleanup();
});

function normalizeSegments(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg.startsWith(":") || /^\{.+\}$/.test(seg) ? "{param}" : seg))
    .join("/");
}

function canonicalFacadePair(pair: string): string {
  const firstSpace = pair.indexOf(" ");
  const method = pair.slice(0, firstSpace);
  const path = pair.slice(firstSpace + 1);
  const prefix = "/cockpit/i/{param}/api";
  return path === prefix || path.startsWith(`${prefix}/`)
    ? `${method} ${path.slice(prefix.length) || "/"}`
    : pair;
}

const EXCLUDED_ROUTES = new Set<string>([
  "GET /v1/identity/desktop-login/confirm",
  "POST /v1/identity/desktop-login/confirm",
  "GET /docs",
  "GET /openapi.json",
  "GET /metrics",
  "GET /llms/{param}",
  "GET /health",
  "GET /ready",
  "POST /v1/tool-approvals/decide",
  "POST /v1/chat/slack/events",
  "POST /v1/chat/slack/interactions",
  "POST /v1/chat/slack/slash",
  "POST /v1/chat/google/events",
  "POST /v1/chat/teams/messages",
  "POST /v1/hooks/{param}",
  "GET /v1/conversations/{param}/stream",
  "GET /v1/executions/{param}/stream",
  "GET /v1/diagnostics/logs/stream",
  "GET /v1/events/stream",
  "GET /v1/cockpit/events/stream",
  "GET /v1/device-runner/stream",
  "GET /v1/audit-log/export.ndjson",
  "POST /v1/extract",
]);

const COCKPIT_WEB_SURFACE = new Set<string>([
  "GET /cockpit/sw.js",
  "HEAD /cockpit/sw.js",
  "GET /cockpit/i/{param}",
  "HEAD /cockpit/i/{param}",
  "GET /cockpit/i/{param}/*",
  "HEAD /cockpit/i/{param}/*",
  "GET /cockpit/i/{param}/manifest.webmanifest",
  "GET /cockpit/i/{param}/icon/{param}",
  "GET /cockpit/i/{param}/sw.js",
  "POST /cockpit/i/{param}/incoming/share",
]);

const MCP_AUTH_OPERATIONS = [
  "GET /.well-known/oauth-protected-resource",
  "GET /.well-known/oauth-protected-resource/mcp",
  "GET /.well-known/oauth-authorization-server",
  "POST /v1/oauth/register",
  "GET /v1/oauth/authorize",
  "POST /v1/oauth/authorize/decision",
  "POST /v1/oauth/token",
  "POST /v1/oauth/revoke",
  "GET /v1/identity/providers",
  "POST /v1/identity/sessions",
  "GET /v1/identity/login/start",
  "POST /v1/identity/login/start",
  "GET /v1/identity/login/callback",
  "POST /v1/identity/logout",
] as const;
const MCP_AUTH_PATHS = new Set(
  MCP_AUTH_OPERATIONS.map((entry) => entry.slice(entry.indexOf(" ") + 1)),
);

describe("openapi route coverage", () => {
  test("publishes the exact common MCP-auth operation set", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    const actual = Object.entries(spec.paths)
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .filter((entry) => MCP_AUTH_PATHS.has(entry.slice(entry.indexOf(" ") + 1)))
      .sort();
    expect(actual).toEqual([...MCP_AUTH_OPERATIONS].sort());
  });

  test("publishes the common MCP-auth schemas as OpenAPI 3.1", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      paths: Record<
        string,
        { post?: { operationId?: string; requestBody?: { required?: boolean } } }
      >;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/v1/identity/sessions"]?.post?.operationId).toBe("createIdentitySession");
    expect(spec.paths["/v1/identity/sessions"]?.post?.requestBody?.required).toBe(true);
    expect(spec.components.schemas.AuthProvider).toEqual({
      type: "object",
      properties: {
        protocol: { type: "string", enum: ["api_key", "oidc"] },
        id: { type: "string" },
        label: { type: "string", minLength: 1 },
      },
      required: ["protocol", "id", "label"],
      additionalProperties: false,
    });
    expect(spec.components.schemas.IdentitySessionRequest).toEqual({
      type: "object",
      properties: {
        provider_id: { type: "string", minLength: 1 },
        identity_token: { type: "string", minLength: 1 },
      },
      required: ["provider_id", "identity_token"],
      additionalProperties: false,
    });
    expect(spec.components.schemas.IdentitySessionResponse).toEqual({
      type: "object",
      properties: {
        api_key: { type: "string" },
        principal_id: { type: "string" },
        context_id: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
      },
      required: ["api_key", "principal_id", "context_id", "email"],
      additionalProperties: false,
    });
  });

  test("route registry enumeration is not vacuous", () => {
    const registry = buildDefaultRegistry(ctx.db);
    const app = createApp({ db: ctx.db, registry });
    const registered = app.routes.filter((r) => r.method !== "ALL");
    expect(registered.length).toBeGreaterThan(200);
  });

  test("every registered route appears in /openapi.json (or is an explicit, commented exclusion)", async () => {
    const registry = buildDefaultRegistry(ctx.db);
    const app = createApp({ db: ctx.db, registry });

    const registeredPairs = new Set<string>();
    for (const route of app.routes) {
      if (route.method === "ALL") continue;
      registeredPairs.add(
        canonicalFacadePair(`${route.method.toUpperCase()} ${normalizeSegments(route.path)}`),
      );
    }

    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    const specPairs = new Set<string>();
    for (const [path, methods] of Object.entries(spec.paths)) {
      const normalized = normalizeSegments(path);
      for (const method of Object.keys(methods)) {
        specPairs.add(`${method.toUpperCase()} ${normalized}`);
      }
    }

    const missing = [...registeredPairs]
      .filter((pair) => !COCKPIT_WEB_SURFACE.has(pair))
      .filter((pair) => !EXCLUDED_ROUTES.has(pair))
      .filter((pair) => !specPairs.has(pair))
      .sort();

    expect(
      missing,
      "a route shipped without its @hono/zod-openapi createRoute() registration; add the registration",
    ).toEqual([]);
  });

  test("normalizes only scoped API facade aliases", () => {
    expect(canonicalFacadePair("GET /cockpit/i/{param}/api/v1/files")).toBe("GET /v1/files");
    expect(canonicalFacadePair("GET /cockpit/i/{param}/api/v1/unknown")).toBe("GET /v1/unknown");
    expect(canonicalFacadePair("GET /cockpit/i/{param}/manifest.webmanifest")).toBe(
      "GET /cockpit/i/{param}/manifest.webmanifest",
    );
  });
});
