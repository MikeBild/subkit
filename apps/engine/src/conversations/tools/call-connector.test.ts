// call_connector tool tests.
//
// Spins up a Bun HTTP server (and a tiny GraphQL responder) on an
// ephemeral port, seeds real connectors against it via the existing
// conversation test ctx, and asserts:
//   - HTTP GET round-trip including auth header injection.
//   - HTTP POST passes the body through.
//   - GraphQL `body: {query, variables}` reaches the same path.
//   - RBAC denial when a member user lacks `connector:read`.
//   - connector_not_found surfaces as a structured error.
//   - non-HTTP/GraphQL drivers (S3) return driver_not_supported_for_call_connector.
//   - Large response bodies are truncated and surface a raw_ref.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, roles, users } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import { callConnectorTool } from "./call-connector.ts";
import type { ToolContext } from "./index.ts";

interface CapturedReq {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

let ctx: ConversationTestCtx;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let captured: CapturedReq[] = [];
let unprivilegedUserId: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("call_connector");
  // Seed an unprivileged user for the RBAC denial path. The default
  // ctx.user_id is admin (full access) and built-in `member` carries
  // connector:read, so neither would exercise the deny path. We
  // create a bare custom role with no permissions and bind a fresh
  // user to it — same trick journey AC4 uses for connector:read.
  const [bareRole] = await ctx.testDb.db
    .insert(roles)
    .values({
      tenant_id: ctx.tenant_id,
      name: "bare-call-connector",
      description: "no permissions",
    })
    .returning();
  const [unprivileged] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenant_id,
      email: "bare-call-connector@test.local",
      role: "enduser",
      role_id: bareRole!.id,
    })
    .returning();
  unprivilegedUserId = unprivileged!.id;

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      captured.push({
        method: req.method,
        path: url.pathname + url.search,
        headers,
        body: bodyText,
      });

      if (url.pathname === "/graphql") {
        // Echo back something resembling a GraphQL response.
        const parsed = bodyText.length > 0 ? JSON.parse(bodyText) : {};
        return Response.json({
          data: {
            __typename: "Query",
            echoed: parsed,
          },
        });
      }
      if (url.pathname === "/v2/droplets") {
        return Response.json({ droplets: [{ id: 1, name: "alpha" }] });
      }
      if (url.pathname === "/v2/large") {
        // > 8 KB JSON to exercise truncateForLlm.
        const big = Array.from({ length: 200 }, (_, i) => ({
          id: i,
          payload: "x".repeat(80),
          extra: "y".repeat(40),
        }));
        return Response.json({ items: big });
      }
      if (url.pathname === "/v2/echo") {
        return Response.json({
          ok: true,
          received: bodyText.length > 0 ? JSON.parse(bodyText) : null,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await ctx.cleanup();
});

async function seedHttpConnector(opts: {
  slug: string;
  authType?: "bearer" | "none";
  tokenValue?: string;
  driver?: "http" | "graphql" | "s3";
  base_url?: string;
}): Promise<{ connector_id: string }> {
  const driver = opts.driver ?? "http";
  const [conn] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug: opts.slug,
      display_name: opts.slug,
      driver,
      environment: "dev",
      auth_type: opts.authType ?? "none",
      base_url: opts.base_url ?? baseUrl,
      config: driver === "graphql" ? { endpoint: `${baseUrl}/graphql` } : {},
    })
    .returning();
  if (!conn) throw new Error("seed connector failed");
  if ((opts.authType ?? "none") === "bearer") {
    await upsertCredential(
      {
        tenant_id: ctx.tenant_id,
        connector_id: conn.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: opts.tokenValue ?? "test-token" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
  }
  return { connector_id: conn.id };
}

function makeToolContext(actorId: string | null = ctx.user_id): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    actor_id: actorId,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: actorId,
      actor_type: actorId ? "user" : "system",
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

describe("call_connector — HTTP", () => {
  test("GET round-trip injects auth header and returns body", async () => {
    captured = [];
    const { connector_id } = await seedHttpConnector({
      slug: "call_get",
      authType: "bearer",
      tokenValue: "TKN-GET",
    });
    const result = await callConnectorTool.execute(makeToolContext(), {
      connector_id,
      method: "GET",
      path: "/v2/droplets",
      query: { per_page: 10 },
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      status: number;
      body: { droplets: Array<{ id: number }> };
      latency_ms: number;
    };
    expect(data.status).toBe(200);
    expect(data.body.droplets[0]!.id).toBe(1);
    expect(typeof data.latency_ms).toBe("number");

    // Server received the resolved URL, query string, and bearer token.
    expect(captured.length).toBe(1);
    const req = captured[0]!;
    expect(req.method).toBe("GET");
    expect(req.path).toContain("/v2/droplets");
    expect(req.path).toContain("per_page=10");
    expect(req.headers.authorization).toBe("Bearer TKN-GET");
  });

  test("POST passes body through with content-type json", async () => {
    captured = [];
    const { connector_id } = await seedHttpConnector({ slug: "call_post" });
    const result = await callConnectorTool.execute(makeToolContext(), {
      connector_id,
      method: "POST",
      path: "/v2/echo",
      body: { hello: "world", n: 42 },
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      status: number;
      body: { received: { hello: string; n: number } };
    };
    expect(data.status).toBe(200);
    expect(data.body.received.hello).toBe("world");
    expect(data.body.received.n).toBe(42);

    expect(captured.length).toBe(1);
    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v2/echo");
    expect(JSON.parse(req.body)).toEqual({ hello: "world", n: 42 });
    expect(req.headers["content-type"]).toContain("application/json");
  });

  test("large response body is truncated and exposes raw_ref", async () => {
    captured = [];
    const { connector_id } = await seedHttpConnector({ slug: "call_large" });
    const result = await callConnectorTool.execute(makeToolContext(), {
      connector_id,
      method: "GET",
      path: "/v2/large",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      truncated: boolean;
      raw_ref?: string;
      body_byte_count: number;
    };
    expect(data.truncated).toBe(true);
    expect(typeof data.raw_ref).toBe("string");
    expect(data.body_byte_count).toBeGreaterThan(8 * 1024);
  });
});

describe("call_connector — GraphQL", () => {
  test("body: {query, variables} reaches the GraphQL endpoint", async () => {
    captured = [];
    const { connector_id } = await seedHttpConnector({
      slug: "call_gql",
      driver: "graphql",
    });
    const result = await callConnectorTool.execute(makeToolContext(), {
      connector_id,
      method: "POST",
      path: "/graphql",
      body: { query: "query Q { __typename }", variables: { id: "abc" } },
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      status: number;
      body: { data: { __typename: string; echoed: { query: string; variables: { id: string } } } };
    };
    expect(data.status).toBe(200);
    expect(data.body.data.echoed.query).toContain("__typename");
    expect(data.body.data.echoed.variables.id).toBe("abc");

    expect(captured.length).toBe(1);
    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/graphql");
    expect(JSON.parse(req.body).query).toContain("__typename");
  });

  test("graphql connector without body: {query} returns invalid_input", async () => {
    captured = [];
    const { connector_id } = await seedHttpConnector({
      slug: "call_gql_bad",
      driver: "graphql",
    });
    const result = await callConnectorTool.execute(makeToolContext(), {
      connector_id,
      method: "POST",
      path: "/graphql",
      body: "not-an-object",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string } }).error;
    expect(err.code).toBe("invalid_input");
    expect(captured.length).toBe(0);
  });
});

describe("call_connector — error envelopes", () => {
  test("connector_not_found is structured", async () => {
    const result = await callConnectorTool.execute(makeToolContext(), {
      connector_id: crypto.randomUUID(), // allow-random: legacy; review before changing
      method: "GET",
      path: "/v2/droplets",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string } }).error;
    expect(err.code).toBe("connector_not_found");
  });

  test("S3 driver returns driver_not_supported_for_call_connector", async () => {
    const { connector_id } = await seedHttpConnector({
      slug: "call_s3",
      driver: "s3",
      base_url: "https://s3.example.test",
    });
    const result = await callConnectorTool.execute(makeToolContext(), {
      connector_id,
      method: "GET",
      path: "/some-bucket/key",
    });
    expect(result.ok).toBe(false);
    const data = result.data as {
      error: { code: string };
      next_best_actions: string[];
    };
    expect(data.error.code).toBe("driver_not_supported_for_call_connector");
    expect(data.next_best_actions).toContain("start_workflow_from_goal");
  });

  test("RBAC: bare-role user without connector:read is denied", async () => {
    const { connector_id } = await seedHttpConnector({ slug: "call_rbac" });
    const result = await callConnectorTool.execute(makeToolContext(unprivilegedUserId), {
      connector_id,
      method: "GET",
      path: "/v2/droplets",
    });
    expect(result.ok).toBe(false);
    const data = result.data as { error: { code: string }; permission?: string };
    expect(data.error.code).toBe("permission_denied");
    expect(data.permission).toBe("connector:read");
  });

  test("auth-required connector with no credential row → credential_required", async () => {
    // Seed bearer connector but DO NOT upsert a credential — emulates an
    // operator who saved the connector skeleton via update_connector but
    // hasn't filled in the secret yet.
    const [conn] = await ctx.testDb.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "call_no_cred",
        display_name: "call_no_cred",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        base_url: baseUrl,
        config: {},
      })
      .returning();
    const result = await callConnectorTool.execute(makeToolContext(), {
      connector_id: conn!.id,
      method: "GET",
      path: "/v2/droplets",
    });
    expect(result.ok).toBe(false);
    const data = result.data as {
      error: { code: string };
      next_best_actions: string[];
    };
    expect(data.error.code).toBe("credential_required");
    expect(data.next_best_actions).toContain("save_connector_draft");
  });
});
