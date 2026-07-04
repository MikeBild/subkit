// S3 encrypted-credential-row resolution.
//
// The anonymous inline-config path is covered by s3-driver.test.ts; this
// suite exercises the store-backed path: header-mode pseudo-headers and
// aws_sigv4 both yield signing material, while every unusable stored
// shape throws a typed S3CredentialError instead of silently sending an
// unsigned request (whose upstream "Missing signature" rejection hides
// the real cause from the operator).
//
// The typed-error cases never open a connection, so they run without
// Docker. The two signing round-trips reuse the MinIO gating pattern
// from s3-driver.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upsertCredential } from "../../credentials/service.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { classifyS3ProbeError } from "../drivers/probe-classify.ts";
import { executeS3Request, probeS3Connector, S3CredentialError } from "../drivers/s3.ts";
import { createConnector, getConnector } from "../service.ts";
import type { ConnectorView } from "../types.ts";

async function dockerAvailable(): Promise<boolean> {
  if (process.env.SKIP_DOCKER === "1") return false;
  const { spawnSync } = await import("node:child_process");
  try {
    return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

interface MinioHandle {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop: () => Promise<void>;
}

async function startMinio(): Promise<MinioHandle> {
  const accessKey = "minioadmin";
  const secretKey = "minioadmin";
  const name = `subkit-minio-cred-test-${Math.random().toString(36).slice(2, 8)}`; // allow-random: unique container name per run
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
  const inspect = Bun.spawnSync([
    "docker",
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}',
    containerId,
  ]);
  const port = Number(new TextDecoder().decode(inspect.stdout).trim());
  if (!port) throw new Error("Failed to determine MinIO mapped port");
  // allow-wall-clock: container warm-up poll before first request.
  const deadline = Date.now() + 30_000;
  // allow-wall-clock: container warm-up poll before first request.
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/minio/health/live`);
      if (res.ok) break;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: MinIO warm-up
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

let testDb: TestDb;
let tenantId: string;
let docker: boolean;
let minio: MinioHandle | null = null;
const BUCKET = `subkit-cred-test-${Math.random().toString(36).slice(2, 8)}`; // allow-random: unique bucket per run

async function makeS3Connector(p: {
  name: string;
  auth_type: "header" | "aws_sigv4" | "bearer";
  endpoint?: string;
}): Promise<ConnectorView> {
  const conn = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name: p.name,
        driver: "s3",
        environment: "dev",
        auth_type: p.auth_type,
        config: {
          region: "us-east-1",
          endpoint: p.endpoint ?? "http://127.0.0.1:1", // never dialed in the typed-error cases
          bucket: BUCKET,
          force_path_style: true,
        },
      },
      actor_id: null,
    },
    testDb.db,
  );
  const fresh = await getConnector(tenantId, conn.id, testDb.db);
  if (!fresh) throw new Error("connector vanished");
  return fresh;
}

beforeAll(async () => {
  testDb = await createTestDb("s3_credentials");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "s3-cred-t", display_name: "s3 cred tenant" })
    .returning();
  tenantId = t!.id;
  docker = await dockerAvailable();
  if (docker) {
    minio = await startMinio();
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
      // bucket may already exist
    }
  }
}, 60_000);

afterAll(async () => {
  if (minio) await minio.stop();
  if (testDb) await testDb.cleanup();
}, 60_000);

describe("s3 credential resolution — typed errors (no network)", () => {
  test("auth-required connector with no stored credential throws credential_missing", async () => {
    const conn = await makeS3Connector({ name: "s3-no-cred", auth_type: "header" });
    try {
      await executeS3Request({
        db: testDb.db,
        tenant_id: tenantId,
        connector: conn,
        method: "LIST",
        path: "/",
      });
      throw new Error("expected S3CredentialError");
    } catch (err) {
      expect(err).toBeInstanceOf(S3CredentialError);
      expect((err as S3CredentialError).error_code).toBe("credential_missing");
    }
  });

  test("bearer-mode credential throws credential_mode_unsupported_for_s3", async () => {
    const conn = await makeS3Connector({ name: "s3-bearer-cred", auth_type: "bearer" });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "not-s3-material" },
        actor_id: null,
      },
      testDb.db,
    );
    try {
      await executeS3Request({
        db: testDb.db,
        tenant_id: tenantId,
        connector: conn,
        method: "LIST",
        path: "/",
      });
      throw new Error("expected S3CredentialError");
    } catch (err) {
      expect(err).toBeInstanceOf(S3CredentialError);
      expect((err as S3CredentialError).error_code).toBe("credential_mode_unsupported_for_s3");
    }
  });

  test("header-mode credential without the s3 pseudo-headers throws credential_invalid", async () => {
    const conn = await makeS3Connector({ name: "s3-bad-header-cred", auth_type: "header" });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "header",
        value: { mode: "header", headers: { "x-api-key": "not-the-s3-shape" } },
        actor_id: null,
      },
      testDb.db,
    );
    try {
      await executeS3Request({
        db: testDb.db,
        tenant_id: tenantId,
        connector: conn,
        method: "LIST",
        path: "/",
      });
      throw new Error("expected S3CredentialError");
    } catch (err) {
      expect(err).toBeInstanceOf(S3CredentialError);
      expect((err as S3CredentialError).error_code).toBe("credential_invalid");
    }
  });

  test("probe classifies S3CredentialError onto the ProbeErrorCode vocabulary", () => {
    expect(classifyS3ProbeError(new S3CredentialError("x", "credential_missing"))).toBe(
      "credential_missing",
    );
    expect(classifyS3ProbeError(new S3CredentialError("x", "credential_invalid"))).toBe(
      "credential_invalid",
    );
    expect(
      classifyS3ProbeError(new S3CredentialError("x", "credential_mode_unsupported_for_s3")),
    ).toBe("credential_invalid");
  });

  test("probe on a connector with an unusable credential reports a typed failure, not ok", async () => {
    const conn = await makeS3Connector({ name: "s3-probe-bearer", auth_type: "bearer" });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "not-s3-material" },
        actor_id: null,
      },
      testDb.db,
    );
    const probe = await probeS3Connector({ db: testDb.db, tenant_id: tenantId, connector: conn });
    expect(probe.ok).toBe(false);
    expect(probe.error_code).toBe("credential_invalid");
  });
});

describe("s3 credential resolution — signing round-trips (MinIO)", () => {
  test("header-mode pseudo-header credential signs requests", async () => {
    if (!docker || !minio) {
      console.log("[s3-credentials.test] skipped: docker not available");
      return;
    }
    const conn = await makeS3Connector({
      name: "s3-header-signed",
      auth_type: "header",
      endpoint: minio.endpoint,
    });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "header",
        value: {
          mode: "header",
          headers: {
            "x-access-key-id": minio.accessKey,
            "x-secret-access-key": minio.secretKey,
          },
        },
        actor_id: null,
      },
      testDb.db,
    );
    const list = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: conn,
      method: "LIST",
      path: "/",
    });
    expect(list.status).toBe(200);
    expect(list.credential_id).not.toBeNull();
  }, 120_000);

  test("aws_sigv4 credential signs requests", async () => {
    if (!docker || !minio) {
      console.log("[s3-credentials.test] skipped: docker not available");
      return;
    }
    const conn = await makeS3Connector({
      name: "s3-sigv4-signed",
      auth_type: "aws_sigv4",
      endpoint: minio.endpoint,
    });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "aws_sigv4",
        value: {
          mode: "aws_sigv4",
          access_key_id: minio.accessKey,
          secret_access_key: minio.secretKey,
        },
        actor_id: null,
      },
      testDb.db,
    );
    const put = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: conn,
      method: "PUT",
      path: "/sigv4.txt",
      body: "signed with aws_sigv4",
    });
    expect(put.status).toBe(200);
    expect(put.credential_id).not.toBeNull();

    const got = await executeS3Request({
      db: testDb.db,
      tenant_id: tenantId,
      connector: conn,
      method: "GET",
      path: "/sigv4.txt",
    });
    expect(got.status).toBe(200);
    const gotBody =
      typeof got.body === "string"
        ? got.body
        : Buffer.isBuffer(got.body)
          ? got.body.toString("utf8")
          : String(got.body ?? "");
    expect(gotBody).toBe("signed with aws_sigv4");
  }, 120_000);
});
