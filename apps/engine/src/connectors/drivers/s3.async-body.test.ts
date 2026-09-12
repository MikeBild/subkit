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
import { createConnector, getConnector } from "../service.ts";
import { executeS3Request } from "./s3.ts";

interface MinioHandle {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop: () => Promise<void>;
}

async function dockerAvailable(): Promise<boolean> {
  if (process.env.SKIP_DOCKER === "1") return false;
  const { spawnSync } = await import("node:child_process");
  try {
    const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
    if (probe.status !== 0) return false;
  } catch {
    return false;
  }
  return true;
}

async function startMinio(): Promise<MinioHandle> {
  const accessKey = "minioadmin";
  const secretKey = "minioadmin";
  const name = `sk-s3-async-${Math.random().toString(36).slice(2, 8)}`; // allow-random: legacy; review before changing

  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "-p",
      "0:9000",
      "-e",
      `MINIO_ROOT_USER=${accessKey}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${secretKey}`,
      "quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
      "server",
      "/data",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const containerId = (await new Response(proc.stdout).text()).trim();
  if (!containerId) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`Failed to start MinIO: ${errText}`);
  }

  const inspect = Bun.spawnSync([
    "docker",
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}',
    containerId,
  ]);
  const port = Number(new TextDecoder().decode(inspect.stdout).trim());
  if (!port) throw new Error("Failed to determine MinIO mapped port");

  // allow-wall-clock: this test exercises real-time polling or freshness windows.
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/minio/health/ready`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: MinIO warm-up
  }
  if (!ready) throw new Error("MinIO did not become ready within 30 seconds");

  return {
    endpoint: `http://127.0.0.1:${port}`,
    accessKey,
    secretKey,
    stop: async () => {
      Bun.spawnSync(["docker", "rm", "-f", containerId]);
    },
  };
}

/** Produce an AsyncIterable that yields `totalBytes` of data in `chunkSize` chunks. */
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

const BUCKET = `sk-s3-async-test-${Math.random().toString(36).slice(2, 8)}`; // allow-random: legacy; review before changing

// Module scope, so the result is known before bun builds the test list.
const DOCKER = await dockerAvailable();
let testDb: TestDb;
let tenantId: string;
let minio: MinioHandle | null = null;
let connectorId: string | null = null;

beforeAll(async () => {
  if (!DOCKER) return;
  testDb = await createTestDb("s3_async_body");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "s3-async-t", display_name: "s3 async tenant" })
    .returning();
  tenantId = t!.id;
  minio = await startMinio();

  const bootstrap = new S3Client({
    region: "us-east-1",
    endPoint: minio.endpoint,
    bucket: BUCKET,
    accessKey: minio.accessKey,
    secretKey: minio.secretKey,
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
          endpoint: minio.endpoint,
          bucket: BUCKET,
          force_path_style: true,
          access_key_id: minio.accessKey,
          secret_access_key: minio.secretKey,
        },
      },
      actor_id: null,
    },
    testDb.db,
  );
  connectorId = conn.id;
}, 60_000);

afterAll(async () => {
  if (minio) await minio.stop();
  if (testDb) await testDb.cleanup();
}, 60_000);

describe.skipIf(!DOCKER)("s3 driver — AsyncIterable<Uint8Array> body", () => {
  test("1 MB AsyncIterable stream: downloaded bytes equal source", async () => {
    if (!minio || !connectorId) throw new Error("MinIO bootstrap did not complete");
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
    if (!minio || !connectorId) throw new Error("MinIO bootstrap did not complete");
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
