// S3 driver round-trip test.
//
// Strategy: spin up a MinIO container via testcontainers, create a
// bucket, and exercise PUT → GET → LIST → HEAD → DELETE through the
// driver. The whole suite is gated on a `dockerAvailable()` probe so a
// laptop without Docker simply logs a "skipped" notice and exits 0
// instead of failing CI.

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
  const name = `subkit-minio-test-${Math.random().toString(36).slice(2, 8)}`;

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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/minio/health/live`);
      if (res.ok) break;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return {
    endpoint: `http://127.0.0.1:${port}`,
    accessKey,
    secretKey,
    stop: async () => {
      Bun.spawnSync(["docker", "rm", "-f", containerId]);
    },
  };
}

let docker: boolean;
let testDb: TestDb;
let tenantId: string;
let minio: MinioHandle | null = null;
let connectorId: string | null = null;
const BUCKET = `subkit-test-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  docker = await dockerAvailable();
  if (!docker) {
    console.log(
      "[s3-driver.test] Docker / MinIO unavailable, skipping S3 round-trip — exiting cleanly.",
    );
    return;
  }
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

describe("s3 driver", () => {
  test("MinIO available + put/get/head/list/delete + probe", async () => {
    if (!docker || !minio || !connectorId) {
      console.log("[s3-driver.test] skipped: docker not available");
      return;
    }
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
    expect(got.body).toBe("hello world");

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
});
