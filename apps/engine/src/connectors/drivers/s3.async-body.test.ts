// S3 driver — AsyncIterable<Uint8Array> body upload tests.
//
// Exercises the driver's buffering path at lines ~267-289 of s3.ts:
// when the body is an AsyncIterable, the driver collects all chunks into
// a Uint8Array before calling putObject. This test verifies round-trip
// correctness for 1 MB and 10 MB streams without Docker skip.
//
// Pattern mirrors apps/engine/src/connectors/tests/s3-driver.test.ts and
// apps/engine/src/storage/object-store.s3.test.ts.

// A case that could not run must report SKIP, never PASS.
//
// LOCAL-SK-DOCKERFALL-ZAEHLT-ALS-BESTANDEN — the docker gate used to be a bare
// `return` in each test body. Under `SKIP_DOCKER=1` (how CI's test shards run)
// this group reported "pass" for cases that had asserted nothing. A count that
// cannot distinguish "verified" from "never ran" is not evidence, and it is
// the number a release reads. The probe now happens once at module scope and
// the suite is gated with `describe.skipIf`, so bun counts them as skipped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  dockerAvailable,
  type ObjectStoreFixture,
  startObjectStore,
} from "../../tests/object-store-fixture.ts";
import { createConnector, getConnector } from "../service.ts";
import { executeS3Request } from "./s3.ts";

async function* buildStream(
  totalBytes: number,
  chunkSize: number,
  fill: number,
): AsyncIterable<Uint8Array> {
  let sent = 0;
  while (sent < totalBytes) {
    const n = Math.min(chunkSize, totalBytes - sent);
    const chunk = new Uint8Array(n).fill(fill);
    yield chunk;
    sent += n;
  }
}

// Module scope, so the result is known before bun builds the test list.
const DOCKER = await dockerAvailable();
let testDb: TestDb;
let tenantId: string;
let objectStore: ObjectStoreFixture | null = null;
let connectorId: string | null = null;
const BUCKET = `sk-s3-async-test-${Math.random().toString(36).slice(2, 8)}`; // allow-random: legacy; review before changing

beforeAll(async () => {
  if (!DOCKER) return;
  testDb = await createTestDb("s3_async_body");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "s3-async-t", display_name: "s3 async tenant" })
    .returning();
  tenantId = t!.id;
  objectStore = await startObjectStore("subkit-s3-async-test");

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
  } catch {
    // ignore if exists
  }

  const conn = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name: "s3-async-test",
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

describe.skipIf(!DOCKER)("s3 driver — AsyncIterable<Uint8Array> body", () => {
  test("1 MB AsyncIterable stream: downloaded bytes equal source", async () => {
    if (!objectStore || !connectorId) throw new Error("object store fixture did not complete");
    const SIZE = 1 * 1024 * 1024;
    const FILL = 0xab;
    const CHUNK = 64 * 1024;
    const stream = buildStream(SIZE, CHUNK, FILL);
    const connector = await getConnector(tenantId, connectorId, testDb.db);
    if (!connector) throw new Error("connector vanished");

    const put = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector,
      method: "PUT",
      path: "/async/1mb.bin",
      body: stream,
      contentType: "application/octet-stream",
    });
    expect(put.status).toBe(200);

    const got = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector,
      method: "GET",
      path: "/async/1mb.bin",
    });
    expect(got.status).toBe(200);

    const body = got.body as Buffer | Uint8Array | string;
    let bytes: Uint8Array;
    if (typeof body === "string") {
      bytes = new TextEncoder().encode(body);
    } else if (Buffer.isBuffer(body)) {
      bytes = new Uint8Array(body);
    } else {
      bytes = body as Uint8Array;
    }
    expect(bytes.byteLength).toBe(SIZE);
    // Spot-check every 100th byte equals the fill value.
    for (let i = 0; i < SIZE; i += 100) {
      expect(bytes[i]).toBe(FILL);
    }
  }, 120_000);

  test("10 MB AsyncIterable stream: downloaded bytes equal source", async () => {
    if (!objectStore || !connectorId) throw new Error("object store fixture did not complete");
    const SIZE = 10 * 1024 * 1024;
    const FILL = 0xcd;
    const CHUNK = 256 * 1024;
    const stream = buildStream(SIZE, CHUNK, FILL);
    const connector = await getConnector(tenantId, connectorId, testDb.db);
    if (!connector) throw new Error("connector vanished");

    const put = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector,
      method: "PUT",
      path: "/async/10mb.bin",
      body: stream,
      contentType: "application/octet-stream",
    });
    expect(put.status).toBe(200);

    const got = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector,
      method: "GET",
      path: "/async/10mb.bin",
    });
    expect(got.status).toBe(200);

    const body = got.body as Buffer | Uint8Array | string;
    let bytes: Uint8Array;
    if (typeof body === "string") {
      bytes = new TextEncoder().encode(body);
    } else if (Buffer.isBuffer(body)) {
      bytes = new Uint8Array(body);
    } else {
      bytes = body as Uint8Array;
    }
    expect(bytes.byteLength).toBe(SIZE);
    // Spot-check every 1000th byte.
    for (let i = 0; i < SIZE; i += 1000) {
      expect(bytes[i]).toBe(FILL);
    }
  }, 180_000);
});
