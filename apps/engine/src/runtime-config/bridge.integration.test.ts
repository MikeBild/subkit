import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AuditAction } from "../audit/index.ts";
import { ConfigSchema } from "../config/schema.ts";
import { auditLog } from "../db/schema/audit.ts";
import {
  executionFixtures,
  executionSteps,
  executions,
  files,
  tenants,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { MemoryObjectStore } from "../storage/object-store.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import {
  bridgeLegacyObjects,
  hasConfigBridgeMarker,
  recordConfigBridgeMarker,
  translateLegacyConfig,
} from "./bridge.ts";

let tdb: TestDb;
let legacyRoot: string;
const uuid = createDeterministicUuidFactory(0xb21d6e);

beforeAll(async () => {
  tdb = await createTestDb("stateless-bridge");
  legacyRoot = mkdtempSync(join(tmpdir(), "sk-stateless-bridge-"));
});

afterAll(async () => {
  rmSync(legacyRoot, { recursive: true, force: true });
  await tdb.cleanup();
});

describe("stateless bridge", () => {
  test("translates supported settings but pins bootstrap database, port, and destination storage", () => {
    const bootstrap = ConfigSchema.parse({
      database: { url: "postgres://destination/subkit" },
      server: { port: 3000 },
      storage: {
        object_store: {
          endpoint: "https://objects.example.test",
          region: "eu-central-1",
          bucket: "subkit-destination",
          access_key_id: "destination-access",
          secret_access_key: "destination-secret",
          force_path_style: true,
        },
      },
    });
    const translated = translateLegacyConfig(
      {
        log: { level: "debug" },
        database: { url: "postgres://legacy/subkit" },
        server: { port: 9876 },
        llm: { provider: "mock", api_key: "legacy-llm-secret" },
        storage: {
          s3: { access_key: "legacy-access", secret_key: "legacy-secret" },
          files: { backend: "local", dir: "/data/blobs" },
          offload: { bucket: "legacy-offload" },
        },
      },
      bootstrap,
    );
    expect(translated.log.level).toBe("debug");
    expect(translated.llm.api_key).toBe("legacy-llm-secret");
    expect(translated.database.url).toBe("postgres://destination/subkit");
    expect(translated.server.port).toBe(3000);
    expect(translated.storage).toEqual(bootstrap.storage);
    expect("files" in translated.storage).toBe(false);
  });

  test("copies local files and fixture offloads, verifies hashes, switches pointers, and reruns idempotently", async () => {
    const [tenant] = await tdb.db
      .insert(tenants)
      .values({ slug: "bridge-tenant", display_name: "Bridge Tenant" })
      .returning();
    if (!tenant) throw new Error("tenant seed failed");

    const fileId = uuid();
    const legacyKey = `${tenant.id}/2026/09/01/${fileId}`;
    const legacyPath = join(legacyRoot, legacyKey);
    await mkdir(join(legacyRoot, tenant.id, "2026", "09", "01"), {
      recursive: true,
    });
    const fileBytes = Buffer.from("legacy-file-payload", "utf8");
    await writeFile(legacyPath, fileBytes);
    await tdb.db.insert(files).values({
      id: fileId,
      tenant_id: tenant.id,
      status: "ready",
      filename: "runbook.txt",
      content_type: "text/plain",
      size_bytes: 0,
      storage_uri: `local://${legacyKey}`,
    });

    const [execution] = await tdb.db
      .insert(executions)
      .values({
        tenant_id: tenant.id,
        status: "succeeded",
        source_kind: "draft",
        request_source: "test",
        execution_mode: "dev",
      })
      .returning();
    if (!execution) throw new Error("execution seed failed");
    const [step] = await tdb.db
      .insert(executionSteps)
      .values({
        tenant_id: tenant.id,
        execution_id: execution.id,
        step_key: "legacy-offload",
        kind: "request",
        status: "succeeded",
      })
      .returning();
    if (!step) throw new Error("execution step seed failed");
    const fixtureBody = { items: [1, 2, 3], source: "legacy" };
    const [fixture] = await tdb.db
      .insert(executionFixtures)
      .values({
        tenant_id: tenant.id,
        kind: "offload",
        execution_id: execution.id,
        step_id: step.id,
        body: fixtureBody,
        byte_size: Buffer.byteLength(JSON.stringify(fixtureBody)),
      })
      .returning();
    if (!fixture) throw new Error("fixture seed failed");
    await tdb.db
      .update(executionSteps)
      .set({ result_storage_uri: `fixture://${fixture.id}` })
      .where(eq(executionSteps.id, step.id));
    await tdb.db
      .update(executions)
      .set({ result_storage_uri: `fixture://${fixture.id}` })
      .where(eq(executions.id, execution.id));

    const destination = new MemoryObjectStore();
    const first = await bridgeLegacyObjects(tdb.db, {
      destination,
      destinationBucket: "subkit-destination",
      legacyFilesDir: legacyRoot,
    });
    expect(first).toEqual({
      files: { scanned: 1, migrated: 1, verified: 0 },
      offloads: { scanned: 1, migrated: 1, verified: 0 },
    });

    const [migratedFile] = await tdb.db.select().from(files).where(eq(files.id, fileId));
    expect(migratedFile?.storage_uri).toStartWith("s3://subkit-destination/bridge/files/");
    expect(migratedFile?.size_bytes).toBe(fileBytes.byteLength);
    expect(migratedFile?.sha256).toBe(createHash("sha256").update(fileBytes).digest("hex"));

    const [migratedStep] = await tdb.db
      .select({ uri: executionSteps.result_storage_uri })
      .from(executionSteps)
      .where(eq(executionSteps.id, step.id));
    const [migratedExecution] = await tdb.db
      .select({ uri: executions.result_storage_uri })
      .from(executions)
      .where(eq(executions.id, execution.id));
    expect(migratedStep?.uri).toStartWith("s3://subkit-destination/bridge/offload/");
    expect(migratedExecution?.uri).toBe(migratedStep?.uri);

    const second = await bridgeLegacyObjects(tdb.db, {
      destination,
      destinationBucket: "subkit-destination",
      legacyFilesDir: legacyRoot,
    });
    expect(second).toEqual({
      files: { scanned: 1, migrated: 0, verified: 1 },
      offloads: { scanned: 1, migrated: 0, verified: 1 },
    });

    const objectAudits = await tdb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditAction.STATELESS_BRIDGE_OBJECT_MIGRATED));
    expect(objectAudits).toHaveLength(2);
    const completions = await tdb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditAction.STATELESS_BRIDGE_COMPLETED));
    expect(completions).toHaveLength(2);
  });

  test("records the config-import recovery marker once", async () => {
    const config = ConfigSchema.parse({
      database: { url: "postgres://destination/subkit" },
    });
    expect(await hasConfigBridgeMarker(tdb.db)).toBe(false);
    await recordConfigBridgeMarker(tdb.db, config, "/legacy/config/subkit.config.json");
    await recordConfigBridgeMarker(tdb.db, config, "/legacy/config/subkit.config.json");
    expect(await hasConfigBridgeMarker(tdb.db)).toBe(true);
    const rows = await tdb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditAction.STATELESS_BRIDGE_CONFIG_IMPORTED));
    expect(rows).toHaveLength(1);
  });
});
