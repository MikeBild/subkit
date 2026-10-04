import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upsertCredential } from "../../credentials/service.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  dockerAvailable,
  type ObjectStoreFixture,
  startObjectStore,
} from "../../tests/object-store-fixture.ts";
import { classifyS3ProbeError } from "../drivers/probe-classify.ts";
import { executeS3Request, probeS3Connector, S3CredentialError } from "../drivers/s3.ts";
import { createConnector, getConnector } from "../service.ts";
import type { ConnectorView } from "../types.ts";

const DOCKER = await dockerAvailable();
let testDb: TestDb;
let tenantId: string;
let objectStore: ObjectStoreFixture | null = null;
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
          endpoint: p.endpoint ?? "http://127.0.0.1:1",
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
  if (DOCKER) {
    objectStore = await startObjectStore("subkit-s3-cred-test");
    const { S3Client } = await import("@bradenmacdonald/s3-lite-client");
    const bootstrap = new S3Client({
      region: "us-east-1",
      endPoint: objectStore.endpoint,
      bucket: BUCKET,
      accessKey: objectStore.accessKey,
      secretKey: objectStore.secretKey,
      pathStyle: true,
    });
    await bootstrap.makeBucket(BUCKET);
  }
}, 120_000);

afterAll(async () => {
  if (objectStore) await objectStore.stop();
  if (testDb) await testDb.cleanup();
}, 120_000);

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

describe.skipIf(!DOCKER)("s3 credential resolution — signing round-trips (real S3 server)", () => {
  test("header-mode pseudo-header credential signs requests", async () => {
    if (!objectStore) throw new Error("object store fixture did not complete");
    const conn = await makeS3Connector({
      name: "s3-header-signed",
      auth_type: "header",
      endpoint: objectStore.endpoint,
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
            "x-access-key-id": objectStore.accessKey,
            "x-secret-access-key": objectStore.secretKey,
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
    if (!objectStore) throw new Error("object store fixture did not complete");
    const conn = await makeS3Connector({
      name: "s3-sigv4-signed",
      auth_type: "aws_sigv4",
      endpoint: objectStore.endpoint,
    });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "aws_sigv4",
        value: {
          mode: "aws_sigv4",
          access_key_id: objectStore.accessKey,
          secret_access_key: objectStore.secretKey,
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
