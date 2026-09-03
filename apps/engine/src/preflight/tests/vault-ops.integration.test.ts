// The host-side vault operations against a real database.
//
// These exist because the CLI's own tests inject a fake `VaultOps`, and a
// fake cannot tell you whether a re-pin actually changes what the next boot
// reads. That is the whole question for `--bind`: `saveRuntimeConfigPatch`
// writes a revision with status `saved` and moves `desired_revision` only,
// while the preflight — and every boot — reads `active_revision`. A re-pin
// that stopped there would print `pinned to … version 3` and leave the
// engine refusing on the old version: a success line on top of the exact
// deadlock the command exists to break.
//
// The second question is the rewrap: that a version written under a
// previous key comes back readable, in place, at the same version number,
// with its AAD intact — because a stored revision holds the literal
// `secret://name/version` string and a new version would orphan it.

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

    // The load-bearing assertion: the ACTIVE pointer moved. A `saved`
    // revision would leave this equal to `before.active_revision`, and the
    // preflight would keep refusing on the version it was already refusing on.
    const after = await getRuntimeConfigState(tdb.db);
    expect(after.active_revision).toBeGreaterThan(before.active_revision);
    expect(after.active_revision).toBe(after.saved_revision);
    expect((await getRuntimeRevision(tdb.db, after.active_revision)).status).toBe("active");

    // And what the preflight itself reads now names the new version.
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
    // Write a version the way an engine running the PREVIOUS key would have:
    // same name, same version number, same AAD, different key.
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

    const report = await rewrapMasterKey(tdb.db, PREVIOUS_KEY);
    expect(report.versions).toBeGreaterThanOrEqual(1);

    // Readable now — and still version 1, because every stored revision
    // holds the literal `secret://name/1` and a new version would orphan it.
    expect(await probeCurrentVersion(tdb.db, name)).toEqual({
      version,
      readable: true,
      absent: false,
    });
  });

  test("a second run is a no-op rather than a double-encrypt", async () => {
    // An interrupted sweep must be re-runnable without knowing how far the
    // first one got, so a version already under the running key is skipped.
    const report = await rewrapMasterKey(tdb.db, PREVIOUS_KEY);
    expect(report.versions).toBe(0);
    expect(report.names).toBe(0);
  });

  test("the previous key being the running key is refused, not silently accepted", async () => {
    await expect(rewrapMasterKey(tdb.db, RUNNING_KEY)).rejects.toThrow(/same/);
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
    await expect(rewrapMasterKey(tdb.db, PREVIOUS_KEY)).rejects.toThrow(/decrypts under neither/);
    // Still unreadable, and still there — the transaction rolled back rather
    // than leaving the vault split across two keys.
    expect(await probeCurrentVersion(tdb.db, name)).toEqual({
      version,
      readable: false,
      absent: false,
    });
  });
});
