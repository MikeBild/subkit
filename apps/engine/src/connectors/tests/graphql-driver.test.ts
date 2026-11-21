import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { upsertCredential } from "../../credentials/service.ts";
import { executionSteps, executions, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { runRequestStep } from "../../execution/steps/request.ts";
import type { StepRunContext } from "../../execution/types.ts";
import { RunLlmBudget } from "../../llm/accounting/index.ts";
import { logger } from "../../logging/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import type { RequestStep } from "../../workflows/types.ts";
import {
  query as gqlQuery,
  graphqlErrorMessages,
  probeGraphQLConnector,
} from "../drivers/graphql.ts";
import { HttpRequestInvalidError } from "../drivers/http.ts";
import { probeConnector } from "../drivers/index.ts";
import { createConnector, getConnector } from "../service.ts";

interface MockServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function startMockGraphQL(): Promise<MockServer> {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("method not allowed");
      return;
    }
    const auth = req.headers.authorization ?? null;
    const text = await readBody(req);
    const body = JSON.parse(text) as { query: string; variables?: Record<string, unknown> };
    const q = body.query.replace(/\s+/g, " ").trim();
    const send = (status: number, payload: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (q.includes("__typename")) {
      send(200, { data: { __typename: "Query" } });
      return;
    }
    if (q.includes("users")) {
      const limit = Number(body.variables?.n ?? 2);
      const users = [
        { id: "u1", name: "alice" },
        { id: "u2", name: "bob" },
        { id: "u3", name: "carol" },
      ].slice(0, limit);
      send(200, { data: { users }, extensions: { auth } });
      return;
    }
    if (q.includes("createUser")) {
      const name = body.variables?.name ?? "anon";
      send(200, { data: { createUser: { id: "uX", name } } });
      return;
    }
    if (q.includes("brokenField")) {
      send(200, { data: null, errors: [{ message: "Cannot query field 'brokenField'" }] });
      return;
    }
    send(400, { errors: [{ message: `unknown op: ${q}` }] });
  };
  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}/graphql`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let testDb: TestDb;
let tenantId: string;
let mock: MockServer;
let connectorId: string;
let bearerConnectorId: string;

beforeAll(async () => {
  testDb = await createTestDb("graphql_driver");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "gql-t", display_name: "graphql tenant" })
    .returning();
  tenantId = t!.id;
  mock = await startMockGraphQL();

  const conn = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name: "gql-test",
        driver: "graphql",
        environment: "dev",
        auth_type: "none",
        base_url: mock.baseUrl,
      },
      actor_id: null,
    },
    testDb.db,
  );
  connectorId = conn.id;

  const auth = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name: "gql-bearer",
        driver: "graphql",
        environment: "dev",
        auth_type: "bearer",
        base_url: mock.baseUrl,
      },
      actor_id: null,
    },
    testDb.db,
  );
  bearerConnectorId = auth.id;
  await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: bearerConnectorId,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "tk-shh" },
      actor_id: null,
    },
    testDb.db,
  );
});

afterAll(async () => {
  if (mock) await mock.close();
  if (testDb) await testDb.cleanup();
});

describe("graphql driver", () => {
  test("health probe + dispatched probe via registry", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const probe = await probeGraphQLConnector({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
    });
    expect(probe.ok).toBe(true);
    expect(probe.status).toBe(200);

    const dispatched = await probeConnector({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
    });
    expect(dispatched.ok).toBe(true);
  });

  test("query operation returns canned users with variables", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      query: "query U($n: Int!) { users(limit: $n) { id name } }",
      variables: { n: 2 },
    });
    expect(res.status).toBe(200);
    const body = res.body as { data?: { users?: Array<{ id: string; name: string }> } };
    expect(body.data?.users?.length).toBe(2);
    expect(body.data?.users?.[0]?.name).toBe("alice");
  });

  test("graphqlErrorMessages surfaces a body.errors response (AppSync HTTP-200-with-errors)", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      query: "query Broken { brokenField }",
    });
    expect(res.status).toBe(200);
    expect(graphqlErrorMessages(res.body)).toEqual(["Cannot query field 'brokenField'"]);
  });

  test("graphql.request.error log carries the actual error messages", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const warnings: Array<Record<string, unknown>> = [];
    const spy = spyOn(logger, "warn").mockImplementation((o: unknown) => {
      warnings.push(o as Record<string, unknown>);
    });
    try {
      await gqlQuery({
        db: testDb.db,
        tenant_id: tenantId,
        connector: fresh!,
        query: "query Broken { brokenField }",
      });
    } finally {
      spy.mockRestore();
    }
    const entry = warnings.find((w) => w.action === "graphql.request.error");
    expect(entry).toBeDefined();
    expect(entry?.has_graphql_errors).toBe(true);
    expect(entry?.error_messages).toEqual(["Cannot query field 'brokenField'"]);
  });

  test("graphqlErrorMessages returns null for a clean response", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      query: "{ users(limit: 1) { id } }",
    });
    expect(graphqlErrorMessages(res.body)).toBeNull();
  });

  test("graphqlErrorMessages — empty / absent / malformed errors", () => {
    expect(graphqlErrorMessages({ data: {} })).toBeNull();
    expect(graphqlErrorMessages({ errors: [] })).toBeNull();
    expect(graphqlErrorMessages(null)).toBeNull();
    expect(graphqlErrorMessages({ errors: [{}] })).toEqual(["graphql error"]);
    expect(graphqlErrorMessages({ errors: [{ message: "a" }, { message: "b" }] })).toEqual([
      "a",
      "b",
    ]);
  });

  test("response carries bytes_in, duration_ms and named operation", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      query: "query GetUsers { users(limit: 1) { id name } }",
    });
    expect(res.status).toBe(200);
    expect(res.bytes_in).toBeGreaterThan(0);
    expect(res.duration_ms).toBeGreaterThanOrEqual(0);
    expect(res.operation_name).toBe("GetUsers");
  });

  test("anonymous query falls back to 'query' as operation name", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      query: "{ users(limit: 1) { id } }",
    });
    expect(res.operation_name).toBe("query");
  });

  test("mutation operation routes through POST", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      operation: "mutation",
      query: "mutation Create($name: String!) { createUser(name: $name) { id name } }",
      variables: { name: "dave" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { data?: { createUser?: { id: string; name: string } } };
    expect(body.data?.createUser?.name).toBe("dave");
  });

  test("subscription returns typed not_implemented error envelope", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      operation: "subscription",
      query: "subscription { tick }",
    });
    expect(res.status).toBe(501);
    const body = res.body as { error?: { code?: string } };
    expect(body.error?.code).toBe("not_implemented");
  });

  test("bearer credential is applied as Authorization header", async () => {
    const fresh = await getConnector(tenantId, bearerConnectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      query: "{ users(limit: 1) { id name } }",
    });
    expect(res.status).toBe(200);
    const body = res.body as { extensions?: { auth?: string } };
    expect(body.extensions?.auth).toBe("Bearer tk-shh");
    expect(res.auth_method).toBe("bearer");
  });

  test("auth_method=none for unauthenticated connector", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      query: "{ users(limit: 1) { id } }",
    });
    if (res.status === 501) throw new Error("unexpected not_implemented");
    expect(res.auth_method).toBe("none");
  });

  test("subscription not_implemented carries auth_method=none", async () => {
    const fresh = await getConnector(tenantId, bearerConnectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      operation: "subscription",
      query: "subscription { tick }",
    });
    expect(res.status).toBe(501);
    expect(res.auth_method).toBe("none");
  });

  test("credential_override skips the DB lookup (draft-time probe)", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const res = await gqlQuery({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      query: "{ users(limit: 1) { id } }",
      credential_override: { mode: "bearer", token: "draft-only" },
    });
    expect(res.status).toBe(200);
    expect(res.auth_method).toBe("bearer");
    const body = res.body as { extensions?: { auth?: string } };
    expect(body.extensions?.auth).toBe("Bearer draft-only");
    expect(res.credential_id).toBeNull();
  });

  test("rejects an invalid outbound header name with HttpRequestInvalidError", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    await expect(
      gqlQuery({
        db: testDb.db,
        tenant_id: tenantId,
        connector: fresh!,
        query: "{ users { id } }",
        extra_headers: { '{"X-Bad': "v" },
      }),
    ).rejects.toBeInstanceOf(HttpRequestInvalidError);
  });

  test("probeGraphQLConnector with credential_override succeeds for auth-required connector with no DB row", async () => {
    const authRequired = await createConnector(
      {
        tenant_id: tenantId,
        input: {
          name: "gql-auth-no-cred",
          driver: "graphql",
          environment: "dev",
          auth_type: "bearer",
          base_url: mock.baseUrl,
        },
        actor_id: null,
      },
      testDb.db,
    );
    const fresh = await getConnector(tenantId, authRequired.id, testDb.db);

    const captured: { auth: string | null } = { auth: null };
    const origFetch = globalThis.fetch;
    const patchedFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      captured.auth = headers.Authorization ?? headers.authorization ?? null;
      return origFetch(url as URL, init);
    };

    const probe = await probeGraphQLConnector({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      credential_override: { mode: "bearer", token: "override-draft-token" },
      fetchImpl: patchedFetch as typeof fetch,
    });

    expect(probe.ok).toBe(true);
    expect(captured.auth).toBe("Bearer override-draft-token");
  });

  test("probeGraphQLConnector without credential_override and no DB row returns credential_required", async () => {
    const authRequired = await createConnector(
      {
        tenant_id: tenantId,
        input: {
          name: "gql-auth-no-cred-v2",
          driver: "graphql",
          environment: "dev",
          auth_type: "bearer",
          base_url: mock.baseUrl,
        },
        actor_id: null,
      },
      testDb.db,
    );
    const fresh = await getConnector(tenantId, authRequired.id, testDb.db);

    let serverHit = false;
    const guardedFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      serverHit = true;
      return globalThis.fetch(url as URL, init);
    };

    const probe = await probeGraphQLConnector({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      fetchImpl: guardedFetch as typeof fetch,
    });

    expect(probe.ok).toBe(false);
    expect(probe.detail).toBe("credential_required");
    expect(serverHit).toBe(false);
  });

  test("failed probe carries detail, body_snippet, and allowlisted response_headers", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const stubFetch = async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: "Basic auth with password is not allowed on this instance" }],
        }),
        {
          status: 403,
          headers: {
            "www-authenticate": 'OAuth realm="https://example.test"',
            "content-type": "application/json",
            "x-seraph-loginreason": "AUTHENTICATED_FAILED",
            "set-cookie": "secret=1",
          },
        },
      );

    const probe = await probeGraphQLConnector({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      fetchImpl: stubFetch as unknown as typeof fetch,
    });

    expect(probe.ok).toBe(false);
    expect(probe.status).toBe(403);
    expect(probe.error_code).toBe("credential_invalid");
    expect(probe.detail).toBe("Basic auth with password is not allowed on this instance");
    expect(probe.body_snippet).toContain(
      "Basic auth with password is not allowed on this instance",
    );
    expect(probe.response_headers?.["www-authenticate"]).toBe('OAuth realm="https://example.test"');
    expect(probe.response_headers?.["x-seraph-loginreason"]).toBe("AUTHENTICATED_FAILED");
    expect(probe.response_headers?.["set-cookie"]).toBeUndefined();
  });

  test("failed probe without GraphQL error messages falls back to HTTP-status detail", async () => {
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    const stubFetch = async () =>
      new Response(JSON.stringify({ errors: [] }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });

    const probe = await probeGraphQLConnector({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      fetchImpl: stubFetch as unknown as typeof fetch,
    });

    expect(probe.ok).toBe(false);
    expect(probe.detail).toBe("HTTP 403");
  });
});

describe("graphql request step · envelope unwrap", () => {
  async function makeGraphqlStepCtx(step: RequestStep): Promise<StepRunContext> {
    const [exec] = await testDb.db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        source_kind: "step",
        status: "running",
        request_source: "api",
        execution_mode: "dev",
      })
      .returning({ id: executions.id });
    if (!exec) throw new Error("exec insert failed");
    const [stepRow] = await testDb.db
      .insert(executionSteps)
      .values({
        tenant_id: tenantId,
        execution_id: exec.id,
        step_key: step.id,
        step_index: 0,
        kind: "request",
        status: "running",
        started_at: new Date(getTestNow()),
      })
      .returning({ id: executionSteps.id });
    if (!stepRow) throw new Error("step row insert failed");
    return {
      db: testDb.db,
      tenant_id: tenantId,
      execution_id: exec.id,
      workflow_id: "",
      workflow_version_id: "",
      request_source: "api",
      parent_execution_id: null,
      depth: 0,
      signal: new AbortController().signal,
      scope: {},
      started_at: new Date(getTestNow()),
      workflow_slug: "test",
      trace_id: null,
      principal: null,
      execution_mode: "dev",
      step,
      step_index: 0,
      step_row_id: stepRow.id,
      persist_workflow_refs: true,
      llm_budget: new RunLlmBudget(null),
    };
  }

  test("step output is the GraphQL data payload (single `data`, no double nesting)", async () => {
    const step: RequestStep = {
      id: "fetch_users",
      kind: "request",
      method: "POST",
      connector_id: connectorId,
      graphql: {
        query: "query U($n: Int!) { users(limit: $n) { id name } }",
        variables: { n: 2 },
      },
      max_retries: 0,
    };
    const ctx = await makeGraphqlStepCtx(step);
    const r = await runRequestStep({ ctx, step, scope: {} });

    expect(r.status).toBe("succeeded");
    expect(r.output).toEqual({
      users: [
        { id: "u1", name: "alice" },
        { id: "u2", name: "bob" },
      ],
    });
    expect(r.request_meta?.extras).toMatchObject({ effect_kind: "read" });
    expect((r.output as Record<string, unknown>).data).toBeUndefined();
    expect((r.output as Record<string, unknown>).errors).toBeUndefined();
  });

  test("a GraphQL errors response fails the step with null output", async () => {
    const step: RequestStep = {
      id: "fetch_broken",
      kind: "request",
      method: "POST",
      connector_id: connectorId,
      graphql: { query: "query Broken { brokenField }" },
      max_retries: 0,
    };
    const ctx = await makeGraphqlStepCtx(step);
    const r = await runRequestStep({ ctx, step, scope: {} });

    expect(r.status).toBe("failed");
    expect(r.output ?? null).toBeNull();
    expect(r.error?.code).toBe("graphql_error");
  });
});
