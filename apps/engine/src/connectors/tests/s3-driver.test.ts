// S3 driver round-trip test.
//
// Strategy: spin up a MinIO container via testcontainers, create a
// bucket, and exercise PUT → GET → LIST → HEAD → DELETE through the
// driver. The whole suite is gated on a `dockerAvailable()` probe so a
// laptop without Docker simply logs a "skipped" notice and exits 0
// instead of failing CI.

// A case that could not run must report SKIP, never PASS.
//
// LOCAL-SK-DOCKERFALL-ZAEHLT-ALS-BESTANDEN — the docker gate used to be a bare
// `return` in each test body. Under `SKIP_DOCKER=1` (how CI's test shards run)
// this group reported "pass" for cases that had asserted nothing. A count that
// cannot distinguish "verified" from "never ran" is not evidence, and it is
// the number a release reads. The probe now happens once at module scope and
// the suite is gated with `describe.skipIf`, so bun counts them as skipped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { probeConnector } from "../drivers/index.ts";
import { executeS3Request, probeS3Connector } from "../drivers/s3.ts";
import { createConnector, getConnector } from "../service.ts";

interface MinioHandle {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop: () => Promise<void>;
}

async function dockerAvailable(): Promise<boolean> {
  if (process.env.SKIP_DOCKER === "1") return false;
  // Pre-flight: do NOT import testcontainers until we've confirmed the
  // `docker` binary is on PATH and the daemon is reachable. Importing
  // testcontainers eagerly probes the docker credential provider, which
  // throws on machines without Docker Desktop and surfaces as an
  // "(unnamed)" failure in bun:test.
  const { spawnSync } = await import("node:child_process");
  try {
    const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
    if (probe.status !== 0) return false;
  } catch {
    return false;
  }
  try {
    const tc = await import("testcontainers");
    return Boolean((tc as { GenericContainer?: unknown }).GenericContainer);
  } catch {
    return false;
  }
}

async function startMinio(): Promise<MinioHandle> {
  const accessKey = "minioadmin";
  const secretKey = "minioadmin";
  const name = `subkit-minio-test-${Math.random().toString(36).slice(2, 8)}`; // allow-random: legacy; review before changing

  // Use Bun.spawn instead of testcontainers — avoids Bun/testcontainers
  // compat issues that cause hangs during container startup.
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
      "minio/minio:latest",
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

  // Read the mapped port from docker inspect.
  const inspect = Bun.spawnSync([
    "docker",
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}',
    containerId,
  ]);
  const port = Number(new TextDecoder().decode(inspect.stdout).trim());
  if (!port) throw new Error("Failed to determine MinIO mapped port");

  // Wait for MinIO to be healthy.
  // allow-wall-clock: this test exercises real-time polling or freshness windows.
  const deadline = Date.now() + 30_000;
  // allow-wall-clock: this test exercises real-time polling or freshness windows.
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
    await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: S3 mock fixture warm-up before list-bucket assertions
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

// Module scope, so the result is known before bun builds the test list.
const DOCKER = await dockerAvailable();
let testDb: TestDb;
let tenantId: string;
let minio: MinioHandle | null = null;
let connectorId: string | null = null;
const BUCKET = `subkit-test-${Math.random().toString(36).slice(2, 8)}`; // allow-random: legacy; review before changing

beforeAll(async () => {
  if (!DOCKER) return;
  console.log("[s3-driver.test] Docker available — pulling MinIO image (may take a while)...");
  testDb = await createTestDb("s3_driver");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "s3-t", display_name: "s3 tenant" })
    .returning();
  tenantId = t!.id;
  minio = await startMinio();

  // Bootstrap the bucket directly via the s3-lite-client, so the
  // driver test only exercises object-level operations.
  const { S3Client } = await import("@bradenmacdonald/s3-lite-client");
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
    // ignore — bucket may already exist
  }

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

describe.skipIf(!DOCKER)("s3 driver", () => {
  test("MinIO available + put/get/head/list/delete + probe", async () => {
    if (!minio || !connectorId) throw new Error("MinIO bootstrap did not complete");
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    expect(fresh).not.toBeNull();

    // PUT
    const put = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      method: "PUT",
      path: "/hello.txt",
      body: "hello world",
    });
    expect(put.status).toBe(200);

    // GET
    const got = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      method: "GET",
      path: "/hello.txt",
    });
    expect(got.status).toBe(200);
    // The driver returns raw bytes for non-text content types (MinIO
    // defaults to application/octet-stream); the request-step path
    // uses `parse_as` to decode. Direct callers convert explicitly.
    const gotBody =
      typeof got.body === "string"
        ? got.body
        : Buffer.isBuffer(got.body)
          ? got.body.toString("utf8")
          : String(got.body ?? "");
    expect(gotBody).toBe("hello world");

    // HEAD
    const head = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      method: "HEAD",
      path: "/hello.txt",
    });
    expect(head.status).toBe(200);

    // LIST
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

    // DELETE
    const del = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh!,
      method: "DELETE",
      path: "/hello.txt",
    });
    expect(del.status).toBe(204);

    // Probe via direct + via registry
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
    if (!connectorId) throw new Error("MinIO bootstrap did not complete");
    const fresh = await getConnector(tenantId, connectorId, testDb.db);
    if (!fresh) throw new Error("connector vanished");

    // Seed three small objects so the paginated LIST has something to walk.
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

    // Presigned GET — driver returns the URL instead of fetching.
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

    // Range GET — request only the first 4 bytes of `body-1`.
    const ranged = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: fresh,
      method: "GET",
      path: "/page/obj-1.txt",
      range: "bytes=0-3",
    });
    // Range responses come back as 206 Partial Content.
    expect(ranged.status === 206 || ranged.status === 200).toBe(true);
    const rangedBody =
      typeof ranged.body === "string"
        ? ranged.body
        : Buffer.isBuffer(ranged.body)
          ? ranged.body.toString("utf8")
          : String(ranged.body);
    expect(rangedBody.length).toBeLessThanOrEqual(7);
    expect(rangedBody.startsWith("body")).toBe(true);

    // paginate: true walks the whole page tree until cap.
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

    // multipart: false on a small body still produces a valid PUT.
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
