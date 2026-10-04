import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  dockerAvailable,
  type ObjectStoreFixture,
  startObjectStore,
} from "../../tests/object-store-fixture.ts";
import { probeConnector } from "../drivers/index.ts";
import { executeS3Request, probeS3Connector } from "../drivers/s3.ts";
import { createConnector, getConnector } from "../service.ts";

const DOCKER = await dockerAvailable();
let testDb: TestDb;
let tenantId: string;
let objectStore: ObjectStoreFixture | null = null;
let connectorId: string | null = null;
const BUCKET = `subkit-test-${Math.random().toString(36).slice(2, 8)}`; // allow-random: legacy; review before changing

beforeAll(async () => {
  if (!DOCKER) return;
  console.log(
    "[s3-driver.test] Docker available — starting the object store (may take a while)...",
  );
  testDb = await createTestDb("s3_driver");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "s3-t", display_name: "s3 tenant" })
    .returning();
  tenantId = t!.id;
  objectStore = await startObjectStore("subkit-s3-driver-test");

  const { S3Client } = await import("@bradenmacdonald/s3-lite-client");
  const bootstrap = new S3Client({
    region: "us-east-1",
    endPoint: objectStore.endpoint,
    bucket: BUCKET,
    accessKey: objectStore.accessKey,
    secretKey: objectStore.secretKey,
    pathStyle: true,
  });
  try {
    await bootstrap.makeBucket(BUCKET);
  } catch {}

  const conn = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name: "s3-test",
        driver: "s3",
        environment: "dev",
        auth_type: "none",
        config: {
          region: "us-east-1",
          endpoint: objectStore.endpoint,
          bucket: BUCKET,
          force_path_style: true,
          access_key_id: objectStore.accessKey,
          secret_access_key: objectStore.secretKey,
        },
      },
      actor_id: null,
    },
    testDb.db,
  );
  connectorId = conn.id;
}, 120_000);

afterAll(async () => {
  if (objectStore) await objectStore.stop();
  if (testDb) await testDb.cleanup();
}, 120_000);

describe.skipIf(!DOCKER)("s3 driver", () => {
  test("store available + put/get/head/list/delete + probe", async () => {
    if (!objectStore || !connectorId) throw new Error("object store fixture did not complete");
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    expect(fresh).not.toBeNull();

    const put = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      method: "PUT",
      path: "/hello.txt",
      body: "hello world",
    });
    expect(put.status).toBe(200);

    const got = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      method: "GET",
      path: "/hello.txt",
    });
    expect(got.status).toBe(200);
    const gotBody =
      typeof got.body === "string"
        ? got.body
        : Buffer.isBuffer(got.body)
          ? got.body.toString("utf8")
          : String(got.body ?? "");
    expect(gotBody).toBe("hello world");

    const head = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      method: "HEAD",
      path: "/hello.txt",
    });
    expect(head.status).toBe(200);

    const list = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      method: "LIST",
      path: "/",
    });
    expect(list.status).toBe(200);
    const listBody = list.body as { items: Array<{ key: string }>; count: number };
    expect(listBody.count).toBeGreaterThanOrEqual(1);
    expect(listBody.items.find((i) => i.key === "hello.txt")).toBeTruthy();

    const del = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      method: "DELETE",
      path: "/hello.txt",
    });
    expect(del.status).toBe(204);

    const probe = await probeS3Connector({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
    });
    expect(probe.ok).toBe(true);
    const dispatched = await probeConnector({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
    });
    expect(dispatched.ok).toBe(true);
  }, 120_000);

  test("presigned URL + range GET + paginated LIST + multipart override", async () => {
    if (!connectorId) throw new Error("object store fixture did not complete");
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    if (!fresh) throw new Error("connector vanished");

    for (const i of [1, 2, 3]) {
      const put = await executeS3Request({
        db: testDb.db,
        tenant_id: tenantId,
        connector: fresh,
        method: "PUT",
        path: `/page/obj-${i}.txt`,
        body: `body-${i}`,
      });
      expect(put.status).toBe(200);
    }

    const presigned = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh,
      method: "GET",
      path: "/page/obj-1.txt",
      presignExpiresIn: 60,
    });
    expect(presigned.status).toBe(200);
    const presignBody = presigned.body as { url: string; method: string; expires_at: string };
    expect(typeof presignBody.url).toBe("string");
    expect(presignBody.url.length).toBeGreaterThan(0);
    expect(presignBody.method).toBe("GET");

    const ranged = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh,
      method: "GET",
      path: "/page/obj-1.txt",
      range: "bytes=0-3",
    });
    expect(ranged.status === 206 || ranged.status === 200).toBe(true);
    const rangedBody =
      typeof ranged.body === "string"
        ? ranged.body
        : Buffer.isBuffer(ranged.body)
          ? ranged.body.toString("utf8")
          : String(ranged.body);
    expect(rangedBody.length).toBeLessThanOrEqual(7);
    expect(rangedBody.startsWith("body")).toBe(true);

    const paged = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh,
      method: "LIST",
      path: "/page/",
      paginate: true,
      maxKeys: 10,
    });
    expect(paged.status).toBe(200);
    const pagedBody = paged.body as { count: number; paginated: boolean };
    expect(pagedBody.paginated).toBe(true);
    expect(pagedBody.count).toBeGreaterThanOrEqual(3);

    const single = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh,
      method: "PUT",
      path: "/page/single.txt",
      body: "single-shot",
      multipart: false,
    });
    expect(single.status).toBe(200);
    const singleBody = single.body as { multipart: boolean };
    expect(singleBody.multipart).toBe(false);
  }, 120_000);
});
