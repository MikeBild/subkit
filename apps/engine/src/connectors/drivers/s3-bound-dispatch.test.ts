import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { loadConnectorSystem } from "../system.ts";
import { executeS3Request } from "./s3.ts";

let testDb: TestDb;
let server: Server;
let endpoint: string;
let requests: string[] = [];
let redirect = false;
let listMode: "normal" | "repeat" | "outside" | "missing" = "normal";
let queries: URLSearchParams[] = [];
let connector: NonNullable<Awaited<ReturnType<typeof loadConnectorSystem>>>["connector"];
let tenant: string;
beforeAll(async () => {
  testDb = await createTestDb("s3-bound-dispatch");
  server = createServer((req, res) => {
    requests.push(`${req.method} ${new URL(req.url ?? "/", endpoint).pathname}`);
    req.resume();
    const query = new URL(req.url ?? "/", endpoint).searchParams;
    queries.push(query);
    if (query.get("list-type") === "2" && !redirect) {
      const second = query.has("continuation-token");
      const key = listMode === "outside" ? "private/secret" : `reports/${second ? "b" : "a"}.json`;
      const truncated = !second || listMode === "repeat";
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<ListBucketResult><IsTruncated>${truncated}</IsTruncated><Contents><Key>${key}</Key><Size>4</Size><ETag>&quot;sample&quot;</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>${truncated && listMode !== "missing" ? "<NextContinuationToken>next+token</NextContinuationToken>" : ""}</ListBucketResult>`,
      );
      return;
    }
    if (redirect) {
      res.writeHead(307, { location: `${endpoint}/unapproved-target` });
      res.end();
    } else {
      res.writeHead(req.method === "DELETE" ? 204 : 200, {
        "content-type": "text/plain",
        etag: '"sample"',
      });
      res.end(req.method === "DELETE" ? undefined : "body");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server address missing");
  endpoint = `http://127.0.0.1:${addr.port}`;
  const [tenantRow] = await testDb.db
    .insert(tenants)
    .values({ slug: "s3-bound", display_name: "S3 Bound" })
    .returning();
  if (!tenantRow) throw new Error("tenant missing");
  tenant = tenantRow.id;
  const [row] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenant,
      slug: "store",
      display_name: "Store",
      driver: "s3",
      auth_type: "aws_sigv4",
      environment: "dev",
      config: { region: "us-east-1", endpoint, bucket: "bucket", force_path_style: true },
    })
    .returning();
  if (!row) throw new Error("connector missing");
  await upsertCredential(
    {
      tenant_id: tenant,
      connector_id: row.id,
      environment: "dev",
      mode: "aws_sigv4",
      value: {
        mode: "aws_sigv4",
        access_key_id: "TESTACCESS",
        secret_access_key: "CANARY-private-s3-secret",
      },
      actor_id: null,
    },
    testDb.db,
  );
  const system = await loadConnectorSystem(tenant, row.id, "dev", testDb.db);
  if (!system) throw new Error("connector system missing");
  connector = system.connector;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb.cleanup();
});
beforeEach(() => {
  requests = [];
  queries = [];
  listMode = "normal";
  redirect = false;
});

describe("bound S3 object dispatch", () => {
  for (const method of ["GET", "PUT", "HEAD", "DELETE"] as const) {
    test(`${method} retains the loaded credential generation and dispatches one request`, async () => {
      const observed: unknown[] = [];
      const result = await executeS3Request({
        db: testDb.db,
        tenant_id: tenant,
        connector,
        method,
        path: "/object",
        ...(method === "PUT" ? { body: "value" } : {}),
        before_dispatch: async (credential) => {
          observed.push(credential);
          return { redirect: "manual" };
        },
      });
      expect(requests).toEqual([`${method} /bucket/object`]);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        credential_id: expect.any(String),
        credential_revision: 1,
        credential_snapshot: {
          connector_id: connector.id,
          environment: "dev",
          credential_id: expect.any(String),
          credential_generation: 1,
          connection_id: null,
          access_token_version: null,
          identity: null,
        },
      });
      expect(JSON.stringify({ result, observed })).not.toContain("CANARY");
    });
  }
  test("denial after credential loading prevents every outbound request", async () => {
    await expect(
      executeS3Request({
        db: testDb.db,
        tenant_id: tenant,
        connector,
        method: "PUT",
        path: "/object",
        body: "value",
        before_dispatch: async () => {
          throw new Error("authority denied");
        },
      }),
    ).rejects.toThrow("authority denied");
    expect(requests).toHaveLength(0);
  });
  test("a redirect cannot forward the approved write to another target", async () => {
    redirect = true;
    await expect(
      executeS3Request({
        db: testDb.db,
        tenant_id: tenant,
        connector,
        method: "PUT",
        path: "/object",
        body: "value",
        before_dispatch: async () => ({ redirect: "manual" }),
      }),
    ).rejects.toMatchObject({ code: "authority_invalid" });
    expect(requests).toEqual(["PUT /bucket/object"]);
  });
});

test("bounded LIST rechecks authority per page and preserves the scoped query", async () => {
  let checks = 0;
  const observations: unknown[] = [];
  const result = await executeS3Request({
    db: testDb.db,
    tenant_id: tenant,
    connector,
    method: "LIST",
    path: "/reports/",
    maxKeys: 2,
    paginate: true,
    before_dispatch: async (_credential, request) => {
      observations.push(request);
      checks += 1;
      return { redirect: "manual" };
    },
  });
  expect(checks).toBe(2);
  expect(observations).toHaveLength(2);
  expect(JSON.stringify(observations)).not.toMatch(/CANARY|Authorization|X-Amz/);
  expect(requests).toEqual(["GET /bucket/", "GET /bucket/"]);
  expect(queries.map((query) => query.get("prefix"))).toEqual(["reports/", "reports/"]);
  expect(queries.map((query) => query.get("max-keys"))).toEqual(["2", "1"]);
  expect(queries[1]!.get("continuation-token")).toBe("next+token");
  expect(result.body).toMatchObject({ count: 2, truncated: false, paginated: true });
});

test("revocation before LIST page two prevents its dispatch", async () => {
  let checks = 0;
  await expect(
    executeS3Request({
      db: testDb.db,
      tenant_id: tenant,
      connector,
      method: "LIST",
      path: "/reports/",
      maxKeys: 2,
      paginate: true,
      before_dispatch: async () => {
        if (++checks === 2) throw new Error("revoked");
        return { redirect: "manual" };
      },
    }),
  ).rejects.toThrow("revoked");
  expect(requests).toHaveLength(1);
});
for (const mode of ["repeat", "outside", "missing"] as const) {
  test(`bounded LIST rejects ${mode} page evidence`, async () => {
    listMode = mode;
    await expect(
      executeS3Request({
        db: testDb.db,
        tenant_id: tenant,
        connector,
        method: "LIST",
        path: "/reports/",
        maxKeys: 10,
        paginate: true,
        before_dispatch: async () => ({ redirect: "manual" }),
      }),
    ).rejects.toThrow("invalid or out-of-scope");
    expect(requests.length).toBeLessThanOrEqual(2);
  });
}
test("bounded LIST stops at the approved key cap", async () => {
  const result = await executeS3Request({
    db: testDb.db,
    tenant_id: tenant,
    connector,
    method: "LIST",
    path: "/reports/",
    maxKeys: 1,
    paginate: true,
    before_dispatch: async () => ({ redirect: "manual" }),
  });
  expect(requests).toHaveLength(1);
  expect(result.body).toMatchObject({ count: 1, truncated: true });
});
test("bounded LIST does not follow redirects", async () => {
  redirect = true;
  await expect(
    executeS3Request({
      db: testDb.db,
      tenant_id: tenant,
      connector,
      method: "LIST",
      path: "/reports/",
      maxKeys: 1,
      before_dispatch: async () => ({ redirect: "manual" }),
    }),
  ).rejects.toMatchObject({ code: "authority_invalid" });
  expect(requests).toHaveLength(1);
});

test("bounded PUT exposes exactly the JSON content type to the authority gate", async () => {
  const seen: unknown[] = [];
  await executeS3Request({
    db: testDb.db,
    tenant_id: tenant,
    connector,
    method: "PUT",
    path: "/reports/daily.json",
    body: "{}",
    contentType: "application/json",
    before_dispatch: async (_credential, request) => {
      seen.push(request);
      return { redirect: "manual" };
    },
  });
  expect(seen).toEqual([
    {
      method: "PUT",
      url: `${endpoint}/bucket/reports/daily.json`,
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  ]);
  expect(requests).toEqual(["PUT /bucket/reports/daily.json"]);
});

test("unbound S3 records the used credential while local presigning records no dispatch", async () => {
  const observed: unknown[] = [];
  const on_credential_use = async (snapshot: unknown) => {
    observed.push(snapshot);
  };
  await executeS3Request({
    db: testDb.db,
    tenant_id: tenant,
    connector,
    method: "GET",
    path: "/object",
    on_credential_use,
  });
  expect(requests).toEqual(["GET /bucket/object"]);
  expect(observed).toEqual([
    expect.objectContaining({
      connector_id: connector.id,
      credential_generation: 1,
      identity: null,
    }),
  ]);
  await executeS3Request({
    db: testDb.db,
    tenant_id: tenant,
    connector,
    method: "GET",
    path: "/object",
    presignExpiresIn: 60,
    on_credential_use,
  });
  expect(requests).toHaveLength(1);
  expect(observed).toHaveLength(1);
});
