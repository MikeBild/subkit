// Route-registry <-> OpenAPI-surface completeness.
//
// `openapi.test.ts` spot-checks fields of the generated spec; this asserts
// coverage: every registered v1 API route appears in `/openapi.json` with at
// least one method entry. A route only ends up in the spec when it's wired
// via `app.openapi(createRoute(...))` (see `apps/engine/AGENTS.md`'s
// Zod-first rule) — a plain `app.get/post/patch/delete(...)` call is fully
// reachable at runtime but invisible to spec generation. That gap is real
// drift (undocumented, untyped API surface) distinct from the deliberate
// exclusions below.
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

/** `{name}` in openapi.json / `:name` (optionally `{regex}`-constrained, e.g.
 *  Hono's `:path{.+}`) in `app.routes` both collapse to a single `{param}`
 *  per path segment — only segment count + literal segments matter here. */
function normalizeSegments(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg.startsWith(":") || /^\{.+\}$/.test(seg) ? "{param}" : seg))
    .join("/");
}

// Deliberately undocumented — not application API surface, so absence from
// the generated spec is by design, not drift:
const EXCLUDED_ROUTES = new Set<string>([
  // Self-describing / infra endpoints about the spec itself, or ops
  // surfaces with no request/response schema worth modeling.
  "GET /docs",
  "GET /openapi.json",
  "GET /metrics",
  "GET /llms/{param}",
  // Unversioned probe aliases. The probes themselves ARE documented — as
  // `GET /v1/health` and `GET /v1/readyz`, with their schemas. These two are
  // the same handlers under the names an infrastructure probe defaults to;
  // publishing them would put a second name for one operation into the spec
  // and into every generated client. `routes/health.ts` owns the aliasing and
  // `health.test.ts` pins that they answer identically and stay out of here.
  "GET /health",
  "GET /ready",
  // Tool-approval decision forms and inbound webhooks have external/raw
  // contracts. MCP authorization and browser identity flows are documented.
  "POST /v1/tool-approvals/decide",
  // Inbound webhook receivers: request shape is dictated by the external
  // platform (Slack/Google Chat/Teams/connector), not by this engine.
  "POST /v1/chat/slack/events",
  "POST /v1/chat/slack/interactions",
  "POST /v1/chat/slack/slash",
  "POST /v1/chat/google/events",
  "POST /v1/chat/teams/messages",
  "POST /v1/hooks/{param}",
  // SSE / NDJSON: not representable in OpenAPI's JSON-schema response
  // model (see `packages/cli-core/src/diagnostics-paths.ts`'s own
  // comment: "the SSE stream is not modeled by the OpenAPI generator").
  "GET /v1/conversations/{param}/stream",
  "GET /v1/executions/{param}/stream",
  "GET /v1/diagnostics/logs/stream",
  "GET /v1/events/stream",
  "GET /v1/audit-log/export.ndjson",
  // Content-type-polymorphic raw-byte body (json/csv/yaml/xml/plaintext +
  // binary pdf/docx/xlsx/pptx dispatched in the handler) — an OpenAPI body
  // schema would second-guess that routing (see ai/extract.ts's module
  // header). The typed JSON surface is the documented POST /v1/ai/extract;
  // the response component ExtractFileResponse is registered standalone.
  "POST /v1/extract",
]);

// Ratchet for undocumented application API surface — routes wired via
// plain `app.get/post/...` instead of `createRoute()`, invisible to the
// spec and the generated CLI types. The pin is exact: a NEW undocumented
// route fails this test (add the registration, don't grow this list), and
// documenting one fails it too until the entry is removed — the list only
// ratchets down. It is empty today; keep it that way.
// Mirrored (for the subset the CLI calls) in
// packages/cli-core/src/engine-api/client-contract.test.ts.
const KNOWN_UNDOCUMENTED_ROUTES: string[] = [];

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
        label: { type: "string", enum: ["SSO", "API key"] },
        issuer: { type: "string", format: "uri" },
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
    // Canary: if `app.routes` ever stops exposing entries (Hono version
    // bump, wrapper change), this fails loudly instead of the coverage
    // test silently passing over zero routes.
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
      if (route.method === "ALL") continue; // catch-all middleware, not an endpoint.
      registeredPairs.add(`${route.method.toUpperCase()} ${normalizeSegments(route.path)}`);
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
      .filter((pair) => !EXCLUDED_ROUTES.has(pair))
      .filter((pair) => !specPairs.has(pair))
      .sort();

    expect(
      missing,
      `Undocumented-route set changed. A NEW entry means a route shipped without its ` +
        `@hono/zod-openapi createRoute() registration (add the registration — do not grow ` +
        `KNOWN_UNDOCUMENTED_ROUTES). A MISSING entry means a route got documented — remove it ` +
        `from KNOWN_UNDOCUMENTED_ROUTES so the ratchet tightens.`,
    ).toEqual(KNOWN_UNDOCUMENTED_ROUTES);
  });
});
