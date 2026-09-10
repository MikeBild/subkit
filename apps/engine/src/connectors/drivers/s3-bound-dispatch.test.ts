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
let connector: NonNullable<Awaited<ReturnType<typeof loadConnectorSystem>>>["connector"];
let tenant: string;
beforeAll(async () => {
  testDb = await createTestDb("s3-bound-dispatch");
  server = createServer((req, res) => {
    requests.push(`${req.method} ${new URL(req.url ?? "/", endpoint).pathname}`);
    req.resume();
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
