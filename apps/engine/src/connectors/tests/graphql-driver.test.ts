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
  });
});
