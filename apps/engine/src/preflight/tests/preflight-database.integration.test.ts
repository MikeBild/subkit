import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, getConfig, loadConfig } from "../../config/loader.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  createSecretVersion,
  initializeRuntimeConfig,
  readSecretVersion,
} from "../../runtime-config/service.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { runPreflightChecks } from "../checks.ts";
import { firstRefusal, PREFLIGHT_EXIT_OK, PREFLIGHT_EXIT_REFUSED } from "../contracts.ts";
import { createPreflightEnvironment } from "../environment.ts";
import { preflightOutcome } from "../runner.ts";
import { parseVaultCliArgs, runVaultCli } from "../vault-cli.ts";
import { createVaultOps, rebindSettingPath } from "../vault-ops.ts";

let tdb: TestDb;
let scratch: string;
const SECRET_NAME = "settings.llm.providers.anthropic.api_key";
const BINDING_PATH = "llm.providers.anthropic.api_key";
const OBJECT_STORE_ENV = {
  OBJECT_STORAGE_ENDPOINT: "https://objects.example.invalid",
  OBJECT_STORAGE_REGION: "eu-central-1",
  OBJECT_STORAGE_BUCKET: "subkit",
  OBJECT_STORAGE_ACCESS_KEY_ID: "id",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "seed-secret",
};

beforeAll(async () => {
  testEnv.MASTER_KEY = "22".repeat(32);
  tdb = await createTestDb("preflight-database");
  scratch = mkdtempSync(join(tmpdir(), "subkit-preflight-database-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(scratch, "seed.json"),
  });
  await initializeRuntimeConfig(tdb.db, getConfig());
  const created = await createSecretVersion(tdb.db, {
    name: SECRET_NAME,
    value: "written-before-preflight",
    created_by: null,
  });
  await rebindSettingPath(tdb.db, BINDING_PATH, SECRET_NAME, created.version);
  Object.assign(testEnv, OBJECT_STORE_ENV);
});

afterAll(async () => {
  for (const key of Object.keys(OBJECT_STORE_ENV)) delete testEnv[key];
  _resetConfigForTests();
  rmSync(scratch, { recursive: true, force: true });
  await tdb.cleanup();
});

function argv(...args: string[]) {
  const parsed = parseVaultCliArgs(args);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.command;
}

describe("preflight against the migrated database", () => {
  test("--preflight answers 0 on it, with every database-backed check having run", async () => {
    expect(await readSecretVersion(tdb.db, SECRET_NAME, 1)).toBe("written-before-preflight");
    const env = createPreflightEnvironment(tdb.db, getConfig());
    const outcome = await runPreflightChecks({ ...env, probeObjectStore: async () => {} });
    expect(firstRefusal(outcome)).toBeNull();
    expect(outcome.results.map((r) => [r.check, r.ok])).toEqual([
      ["master_key", true],
      ["schema", true],
      ["object_store", true],
      ["settings_revision", true],
      ["secret_bindings", true],
      ["identity", true],
    ]);
  });

  test("the full command against the same schema refuses or passes — it never crashes", async () => {
    const outcome = await preflightOutcome(tdb.db, getConfig());
    expect([PREFLIGHT_EXIT_OK, PREFLIGHT_EXIT_REFUSED]).toContain(outcome.exitCode);
    if (outcome.exitCode === PREFLIGHT_EXIT_REFUSED) {
      expect(outcome.lines[0]).toContain('"code":"object_store_unreachable"');
      expect(outcome.lines[0]).not.toMatch(/column|does not exist/i);
    }
  });

  test("--vault-check and --vault-set work on it", async () => {
    const ops = createVaultOps(tdb.db, () => preflightOutcome(tdb.db, getConfig()));
    const name = SECRET_NAME;
    expect(await runVaultCli(argv("--vault-check", name), { ops })).toEqual({
      exitCode: 0,
      lines: [`${name}: readable (version 1)`],
    });

    const valueFile = join(scratch, "value");
    writeFileSync(valueFile, "rotated-by-vault-set\n");
    const rotated = await runVaultCli(argv("--vault-set", name, "--value-file", valueFile), {
      ops,
    });
    expect(rotated.exitCode).toBe(0);
    expect(rotated.lines[0]).toBe(`${name}: rotated to version 2`);
    expect(await readSecretVersion(tdb.db, name, 2)).toBe("rotated-by-vault-set");
  });
});
