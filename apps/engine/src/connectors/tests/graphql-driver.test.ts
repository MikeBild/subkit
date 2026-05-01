// GraphQL driver test.
//
// Spins up a tiny Hono server on a random port that mocks a GraphQL
// endpoint. The server understands two queries — `{ __typename }` and
// `{ users(limit: $n) { id name } }` — plus a no-op `createUser`
// mutation. The driver is then exercised through the connector layer so
// the credential + auth path is also covered.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { upsertCredential } from "../../credentials/service.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { query as gqlQuery, probeGraphQLConnector } from "../drivers/graphql.ts";
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
        config: { endpoint: mock.baseUrl },
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
        config: { endpoint: mock.baseUrl },
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
    // Reports the applied auth method back to callers — the request step
    // threads this onto request_meta.connector.auth_method for audit.
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
    // Use the unauthenticated connector but inject a draft bearer credential
    // — mirrors the HTTP driver's `credential_override` path used by
    // probe_connector_draft to test pre-persist drafts.
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
    // No persisted credential row was created — the override path bypasses
    // the DB so credential_id stays null.
    expect(res.credential_id).toBeNull();
  });

  // Audit anti-pattern C1: a malformed header bag must throw
  // HttpRequestInvalidError before reaching `fetch()`. Without this
  // the GraphQL pipeline crashed inside `new Headers()` with an
  // obtuse "Invalid header name" message routed as `graphql_error`.
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
});
