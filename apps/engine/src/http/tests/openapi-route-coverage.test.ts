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
  // OAuth 2.1 authorization-server protocol endpoints (RFC 8414 / 9728 /
  // 7591 / 7009 / 6749) — shape is dictated by the OAuth spec the MCP
  // client talks to, not by this engine's own API contract.
  "GET /.well-known/oauth-authorization-server",
  "GET /.well-known/oauth-protected-resource",
  "GET /.well-known/oauth-protected-resource/mcp",
  "GET /v1/oauth/authorize",
  "POST /v1/oauth/authorize/decision",
  "POST /v1/oauth/register",
  "POST /v1/oauth/revoke",
  "POST /v1/oauth/token",
  // Browser-redirect human flows (OIDC login, session logout, the
  // tool-approval decision form) — same bucket as "oauth callbacks": a
  // human with a browser and no API key, not a JSON API consumer route.
  // (`GET /v1/tool-approvals/decide`, the portal *page*, IS documented;
  // only the form's POST target is excluded here.)
  "GET /v1/identity/login/start",
  "GET /v1/identity/login/callback",
  "POST /v1/identity/logout",
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
]);

// Known drift, pinned as a ratchet — these routes ARE application API
// surface and SHOULD carry a `createRoute()` registration, but today they
// are wired via plain `app.get/post/...` and so are invisible to the spec
// and to the generated CLI types. The pin is exact: a new undocumented
// route fails this test (add the registration, don't grow this list), and
// migrating one of these to `createRoute()` fails it too until the entry
// is removed — the list only ratchets down.
// Mirrored (for the subset the CLI calls) in
// packages/cli-core/src/engine-api/client-contract.test.ts.
const KNOWN_UNDOCUMENTED_ROUTES = [
  "DELETE /v1/rbac/grants/{param}",
  "DELETE /v1/rbac/groups/{param}",
  "DELETE /v1/rbac/groups/{param}/members/{param}",
  "DELETE /v1/rbac/groups/{param}/roles/{param}",
  "DELETE /v1/rbac/roles/{param}",
  "DELETE /v1/rbac/roles/{param}/permissions/{param}",
  "GET /v1/rbac/grants",
  "GET /v1/rbac/groups",
  "GET /v1/rbac/permissions",
  "GET /v1/rbac/roles",
  "GET /v1/rbac/roles/{param}",
  "PATCH /v1/rbac/groups/{param}",
  "PATCH /v1/rbac/roles/{param}",
  "POST /v1/connectors/{param}/credentials/setup",
  "POST /v1/conversations/{param}/messages/upload",
  "POST /v1/discovery/runs",
  "POST /v1/discovery/runs/from-archive",
  "POST /v1/extract",
  "POST /v1/knowledge-sources",
  "POST /v1/rbac/can",
  "POST /v1/rbac/grants",
  "POST /v1/rbac/groups",
  "POST /v1/rbac/groups/{param}/members/{param}",
  "POST /v1/rbac/groups/{param}/roles/{param}",
  "POST /v1/rbac/roles",
  "POST /v1/rbac/roles/{param}/permissions",
  "POST /v1/rbac/users/{param}/role",
];

describe("openapi route coverage", () => {
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
