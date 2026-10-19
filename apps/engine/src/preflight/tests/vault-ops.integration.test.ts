import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, getConfig, loadConfig } from "../../config/loader.ts";
import { encryptSecretWithKey, parseMasterKeyHex } from "../../crypto/aes-gcm.ts";
import { runtimeSecretVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  createSecretVersion,
  getRuntimeConfigState,
  getRuntimeRevision,
  initializeRuntimeConfig,
} from "../../runtime-config/service.ts";
import { syntheticVaultStopAcknowledgement } from "../../test-helpers/vault-maintenance.ts";
import { activeSettingsDocument, secretAad } from "../environment.ts";
import { probeCurrentVersion, rebindSettingPath, rewrapMasterKey } from "../vault-ops.ts";

const RUNNING_KEY = "11".repeat(32);
const PREVIOUS_KEY = "22".repeat(32);
const BOUND_PATH = "llm.providers.anthropic.api_key";

let tdb: TestDb;
let configDir: string;

beforeAll(async () => {
  process.env.MASTER_KEY = RUNNING_KEY;
  tdb = await createTestDb("preflight-vault-ops");
  configDir = mkdtempSync(join(tmpdir(), "sk-preflight-vault-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  await initializeRuntimeConfig(tdb.db, getConfig());
});

afterAll(async () => {
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  await tdb.cleanup();
});

describe("--vault-set --bind", () => {
  test("the re-pinned reference is what the NEXT BOOT reads, not merely what was saved", async () => {
    const before = await getRuntimeConfigState(tdb.db);
    const created = await createSecretVersion(tdb.db, {
      name: "settings.llm.providers.anthropic.api_key",
      value: "rotated-value",
      created_by: null,
    });

    const pinned = await rebindSettingPath(
      tdb.db,
      BOUND_PATH,
      "settings.llm.providers.anthropic.api_key",
      created.version,
    );
    expect(pinned).toEqual({
      path: BOUND_PATH,
      name: "settings.llm.providers.anthropic.api_key",
      version: created.version,
    });

    const after = await getRuntimeConfigState(tdb.db);
    expect(after.active_revision).toBeGreaterThan(before.active_revision);
    expect(after.active_revision).toBe(after.saved_revision);
    expect((await getRuntimeRevision(tdb.db, after.active_revision)).status).toBe("active");

    const document = await activeSettingsDocument(tdb.db);
    const llm = (document?.llm ?? {}) as Record<string, unknown>;
    const providers = (llm.providers ?? {}) as Record<string, unknown>;
    const anthropic = (providers.anthropic ?? {}) as Record<string, unknown>;
    expect(anthropic.api_key).toBe(
      `secret://settings.llm.providers.anthropic.api_key/${created.version}`,
    );
  });

  test("an unknown settings path is refused and activates nothing", async () => {
    const before = await getRuntimeConfigState(tdb.db);
    await expect(
      rebindSettingPath(tdb.db, "no.such.path", "settings.llm.providers.anthropic.api_key", 1),
    ).rejects.toThrow(/unknown setting path/);
    const after = await getRuntimeConfigState(tdb.db);
    expect(after.active_revision).toBe(before.active_revision);
    expect(after.saved_revision).toBe(before.saved_revision);
  });
});

describe("--rewrap-master-key", () => {
  test("a version written under the previous key comes back readable, in place", async () => {
    const name = "settings.rewrap.fixture";
    const version = 1;
    const payload = encryptSecretWithKey(
      parseMasterKeyHex(PREVIOUS_KEY),
      "written-under-the-old-key",
      secretAad(name, version),
    );
    await tdb.db.insert(runtimeSecretVersions).values({
      name,
      version,
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      auth_tag: payload.auth_tag,
      created_by: null,
    });

    expect(await probeCurrentVersion(tdb.db, name)).toEqual({
      version,
      readable: false,
      absent: false,
    });

    const report = await rewrapMasterKey(tdb.db, PREVIOUS_KEY, syntheticVaultStopAcknowledgement);
    expect(report.versions).toBeGreaterThanOrEqual(1);

    expect(await probeCurrentVersion(tdb.db, name)).toEqual({
      version,
      readable: true,
      absent: false,
    });
  });

  test("a second run is a no-op rather than a double-encrypt", async () => {
    const report = await rewrapMasterKey(tdb.db, PREVIOUS_KEY, syntheticVaultStopAcknowledgement);
    expect(report.versions).toBe(0);
    expect(report.names).toBe(0);
  });

  test("the previous key being the running key is refused, not silently accepted", async () => {
    await expect(
      rewrapMasterKey(tdb.db, RUNNING_KEY, syntheticVaultStopAcknowledgement),
    ).rejects.toThrow(/same/);
  });

  test("a version under a third key aborts the sweep and changes nothing", async () => {
    const name = "settings.rewrap.third-key";
    const version = 1;
    const payload = encryptSecretWithKey(
      parseMasterKeyHex("33".repeat(32)),
      "written-under-a-key-nobody-supplied",
      secretAad(name, version),
    );
    await tdb.db.insert(runtimeSecretVersions).values({
      name,
      version,
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      auth_tag: payload.auth_tag,
      created_by: null,
    });
    await expect(
      rewrapMasterKey(tdb.db, PREVIOUS_KEY, syntheticVaultStopAcknowledgement),
    ).rejects.toThrow(/decrypts under neither/);
    expect(await probeCurrentVersion(tdb.db, name)).toEqual({
      version,
      readable: false,
      absent: false,
    });
  });
});
