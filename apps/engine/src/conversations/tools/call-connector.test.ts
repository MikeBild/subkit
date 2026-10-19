import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as pgDriver from "../../connectors/drivers/postgres.ts";
import * as s3Driver from "../../connectors/drivers/s3.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, roles, schemaVersions, users } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import { callConnectorTool } from "./call-connector.ts";
import type { ToolContext } from "./index.ts";
import { checkToolPermission } from "./permission-gate.ts";

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
      role_id: bareRole!.id,
    })
    .returning();
  unprivilegedUserId = unprivileged!.id;

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
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
  driver?: "http" | "graphql" | "s3" | "postgres";
  base_url?: string;
  dsn?: string;
  config?: Record<string, unknown>;
}): Promise<{ connector_id: string }> {
  const driver = opts.driver ?? "http";
  const cfg =
    opts.config !== undefined
      ? opts.config
      : driver === "s3"
        ? { region: "us-east-1", bucket: "test-bucket" }
        : {};
  const baseUrlField =
    driver === "postgres"
      ? null
      : driver === "graphql"
        ? (opts.base_url ?? `${baseUrl}/graphql`)
        : (opts.base_url ?? baseUrl);
  const dsnField =
    opts.dsn ?? (driver === "postgres" ? "postgres://u:p@example.test:5432/db" : null);
  const [conn] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug: opts.slug,
      display_name: opts.slug,
      driver,
      environment: "dev",
      auth_type: opts.authType ?? "none",
      base_url: baseUrlField,
      dsn: dsnField,
      config: cfg,
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

    expect(captured.length).toBe(1);
    const req = captured[0]!;
    expect(req.method).toBe("GET");
    expect(req.path).toContain("/v2/droplets");
    expect(req.path).toContain("per_page=10");
    expect(req.headers.authorization).toBe("Bearer TKN-GET");
  });

  test("healthy 200 → health:ok, no suggestion attached", async () => {
    captured = [];
    const { connector_id } = await seedHttpConnector({ slug: "call_healthy" });
    const result = await callConnectorTool.execute(makeToolContext(), {
      connector_id,
      method: "GET",
      path: "/v2/droplets",
    });
    const data = result.data as { health: string; next_best_actions?: string[] };
    expect(data.health).toBe("ok");
    expect(data.next_best_actions).toBeUndefined();
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

  test("RBAC: bare-role user without connector:read is denied", async () => {
    const { connector_id } = await seedHttpConnector({ slug: "call_rbac" });
    const permission = callConnectorTool.permission!;
    const check = await checkToolPermission(makeToolContext(unprivilegedUserId), permission, {
      connector_id,
      method: "GET",
      path: "/v2/droplets",
    });
    expect(check.allow).toBe(false);
    if (check.allow) throw new Error("expected the bare-role user to be denied");
    const result = permission.denyResult!(check.permission, check.reason);
    expect(result.ok).toBe(false);
    const data = result.data as { error: { code: string }; permission?: string };
    expect(data.error.code).toBe("permission_denied");
    expect(data.permission).toBe("connector:read");
  });

  test("auth-required connector with no credential row → credential_required", async () => {
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

describe("call_connector — schema shape recording", () => {
  async function shapeRowsFor(connector_id: string) {
    return ctx.testDb.db
      .select({
        endpoint_key: schemaVersions.endpoint_key,
        schema: schemaVersions.schema,
      })
      .from(schemaVersions)
      .where(
        and(
          eq(schemaVersions.tenant_id, ctx.tenant_id),
          eq(schemaVersions.connector_id, connector_id),
        ),
      );
  }

  const routedFetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/v2/missing")) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(
      Response.json({ droplets: [{ id: 1, name: "alpha" }] }, { status: 200 }),
    );
  }) as typeof fetch;

  test("2xx response records the body shape keyed `<METHOD> <path>` (query stripped)", async () => {
    const { connector_id } = await seedHttpConnector({ slug: "call_shape_2xx" });
    const result = await withSelfHostedDriverFetchForTests(routedFetch, () =>
      callConnectorTool.execute(makeToolContext(), {
        connector_id,
        method: "GET",
        path: "/v2/droplets?page=2",
      }),
    );
    expect(result.ok).toBe(true);
    expect((result.data as { status: number }).status).toBe(200);

    const rows = await shapeRowsFor(connector_id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.endpoint_key).toBe("GET /v2/droplets");
    const shape = rows[0]!.schema as {
      type: string;
      properties: Record<string, { type: string }>;
    };
    expect(shape.type).toBe("object");
    expect(shape.properties.droplets!.type).toBe("array");
  });

  test("4xx response does NOT record a shape", async () => {
    const { connector_id } = await seedHttpConnector({ slug: "call_shape_4xx" });
    const result = await withSelfHostedDriverFetchForTests(routedFetch, () =>
      callConnectorTool.execute(makeToolContext(), {
        connector_id,
        method: "GET",
        path: "/v2/missing",
      }),
    );
    expect(result.ok).toBe(true);
    expect((result.data as { status: number }).status).toBe(404);

    const rows = await shapeRowsFor(connector_id);
    expect(rows.length).toBe(0);
  });
});

describe("call_connector — Postgres", () => {
  test("SELECT happy path returns rows", async () => {
    const { connector_id } = await seedHttpConnector({
      slug: "call_pg_select",
      driver: "postgres",
      dsn: "postgres://u:p@example.test:5432/db",
    });
    const sampleRows = [{ id: 1, name: "alpha" }];
    const spy = spyOn(pgDriver, "pgQueryWithCount").mockResolvedValue({
      rows: sampleRows,
      row_count: sampleRows.length,
    });
    try {
      const result = await callConnectorTool.execute(makeToolContext(), {
        connector_id,
        sql: "SELECT id, name FROM users",
      });
      expect(result.ok).toBe(true);
      const data = result.data as {
        driver_kind: string;
        body: { rows: unknown[]; row_count: number };
      };
      expect(data.driver_kind).toBe("postgres");
      expect(data.body.rows).toEqual(sampleRows);
      expect(data.body.row_count).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0]![0] as { sql: string };
      expect(call.sql).toMatch(/LIMIT 100$/);
    } finally {
      spy.mockRestore();
    }
  });

  test("mutation without allow_writes is rejected with writes_not_allowed", async () => {
    const { connector_id } = await seedHttpConnector({
      slug: "call_pg_block_write",
      driver: "postgres",
      dsn: "postgres://u:p@example.test:5432/db",
    });
    const spy = spyOn(pgDriver, "pgQueryWithCount").mockResolvedValue({
      rows: [],
      row_count: 0,
    });
    try {
      const result = await callConnectorTool.execute(makeToolContext(), {
        connector_id,
        sql: "DELETE FROM users WHERE id = 1",
      });
      expect(result.ok).toBe(false);
      const data = result.data as {
        error: { code: string };
        next_best_actions: string[];
      };
      expect(data.error.code).toBe("writes_not_allowed");
      expect(data.next_best_actions).toContain("call_connector_with_allow_writes");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("mutation WITH allow_writes:true passes through", async () => {
    const { connector_id } = await seedHttpConnector({
      slug: "call_pg_allow_write",
      driver: "postgres",
      dsn: "postgres://u:p@example.test:5432/db",
    });
    const spy = spyOn(pgDriver, "pgQueryWithCount").mockResolvedValue({
      rows: [],
      row_count: 0,
    });
    try {
      const result = await callConnectorTool.execute(makeToolContext(), {
        connector_id,
        sql: "DELETE FROM users WHERE id = $1",
        parameters: [42],
        allow_writes: true,
      });
      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0]![0] as { sql: string; params: unknown[] };
      expect(call.sql).not.toMatch(/LIMIT 100/);
      expect(call.params).toEqual([42]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("call_connector — S3", () => {
  test("GET happy path returns object body", async () => {
    const { connector_id } = await seedHttpConnector({
      slug: "call_s3_get",
      driver: "s3",
      base_url: "https://s3.example.test",
      config: { region: "us-east-1", bucket: "test-bucket" },
    });
    const spy = spyOn(s3Driver, "executeS3Request").mockResolvedValue({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "hello world",
      credential_id: null,
    });
    try {
      const result = await callConnectorTool.execute(makeToolContext(), {
        connector_id,
        method: "GET",
        path: "/some-key",
      });
      expect(result.ok).toBe(true);
      const data = result.data as { driver_kind: string; status: number; body: string };
      expect(data.driver_kind).toBe("s3");
      expect(data.status).toBe(200);
      expect(data.body).toBe("hello world");
      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0]![0] as { method: string; path: string };
      expect(call.method).toBe("GET");
      expect(call.path).toBe("/some-key");
    } finally {
      spy.mockRestore();
    }
  });
});
