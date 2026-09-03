// The preflight and the host commands run BEFORE this release's migrations,
// against the schema the previous release left behind. A query on that path
// that names a column this release added does not refuse — it crashes, and
// exit 1 instead of 0 or 3 rolls a deploy back. Learned on a production
// rollout on 2026-09-03; this file is what keeps it learned.
//
// The database here is migrated only up to 0047, the last migration of
// 6.28. 0048 (this release) adds `pending_since`, `prepared_by` and
// `pending_bindings` to `runtime_secret_versions`, `connection_id` to
// `credentials`, `client_uri` to `mcp_oauth_clients`, and two tables.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { _resetConfigForTests, getConfig, loadConfig } from "../../config/loader.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { hasPendingSecretColumns } from "../../runtime-config/secret-columns.ts";
import {
  createSecretVersion,
  initializeRuntimeConfig,
  readSecretVersion,
} from "../../runtime-config/service.ts";
import { runPreflightChecks } from "../checks.ts";
import { firstRefusal, PREFLIGHT_EXIT_OK, PREFLIGHT_EXIT_REFUSED } from "../contracts.ts";
import { createPreflightEnvironment } from "../environment.ts";
import { preflightOutcome } from "../runner.ts";
import { parseVaultCliArgs, runVaultCli } from "../vault-cli.ts";
import { createVaultOps, rebindSettingPath } from "../vault-ops.ts";

/** The last migration of the previous release. Bump it when the next release ships. */
const PREVIOUS_RELEASE_LAST_MIGRATION_IDX = 47;

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
  process.env.MASTER_KEY = "22".repeat(32);
  tdb = await createTestDb("preflight-prev", { upToIdx: PREVIOUS_RELEASE_LAST_MIGRATION_IDX });
  scratch = mkdtempSync(join(tmpdir(), "sk-preflight-prev-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(scratch, "seed.json"),
  });
  // Revision 1, then a secret version bound into the ACTIVE document the
  // way the previous release's `--vault-set --bind` did it — exactly what
  // check 5 has to read, and what check 3 reads for a stored binding.
  await initializeRuntimeConfig(tdb.db, getConfig());
  const created = await createSecretVersion(tdb.db, {
    name: SECRET_NAME,
    value: "written-under-the-old-schema",
    created_by: null,
  });
  await rebindSettingPath(tdb.db, BINDING_PATH, SECRET_NAME, created.version);
  // The object store comes from the revision-1 seed variables; the probe is
  // replaced in the one test that asserts a pass.
  Object.assign(process.env, OBJECT_STORE_ENV);
});

afterAll(async () => {
  for (const key of Object.keys(OBJECT_STORE_ENV)) delete process.env[key];
  _resetConfigForTests();
  rmSync(scratch, { recursive: true, force: true });
  await tdb.cleanup();
});

function argv(...args: string[]) {
  const parsed = parseVaultCliArgs(args);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.command;
}

describe("the previous release's schema", () => {
  test("really is the previous schema", async () => {
    const columns = await tdb.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'runtime_secret_versions'`,
    );
    const names = (columns.rows as Array<{ column_name: string }>).map((r) => r.column_name);
    expect(names).toContain("ciphertext");
    expect(names).not.toContain("pending_since");
    expect(await hasPendingSecretColumns(tdb.db)).toBe(false);
  });

  test("--preflight answers 0 on it, with every database-backed check having run", async () => {
    // The active document really binds the secret written above.
    expect(await readSecretVersion(tdb.db, SECRET_NAME, 1)).toBe("written-under-the-old-schema");
    // The object-store probe is the one network call; everything else is
    // the real read path against the real old schema.
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
    // Without a reachable object store this is a refusal (exit 3), and the
    // refusal must be about the store, not about a column.
    const outcome = await preflightOutcome(tdb.db, getConfig());
    expect([PREFLIGHT_EXIT_OK, PREFLIGHT_EXIT_REFUSED]).toContain(outcome.exitCode);
    if (outcome.exitCode === PREFLIGHT_EXIT_REFUSED) {
      expect(outcome.lines[0]).toContain('"code":"object_store_unreachable"');
      expect(outcome.lines[0]).not.toMatch(/column|does not exist/i);
    }
  });

  test("--vault-check and --vault-set work on it; --pending says why it cannot yet", async () => {
    const ops = createVaultOps(tdb.db, () => preflightOutcome(tdb.db, getConfig()));
    const name = SECRET_NAME;
    expect(await runVaultCli(argv("--vault-check", name), { ops })).toEqual({
      exitCode: 0,
      lines: [`${name}: readable (version 1)`],
    });

    const valueFile = join(scratch, "value");
    writeFileSync(valueFile, "rotated-under-the-old-schema\n");
    const rotated = await runVaultCli(argv("--vault-set", name, "--value-file", valueFile), {
      ops,
    });
    expect(rotated.exitCode).toBe(0);
    expect(rotated.lines[0]).toBe(`${name}: rotated to version 2`);
    expect(await readSecretVersion(tdb.db, name, 2)).toBe("rotated-under-the-old-schema");

    const pending = await runVaultCli(
      argv("--vault-set", name, "--value-file", valueFile, "--pending"),
      { ops },
    );
    expect(pending.exitCode).toBe(1);
    expect(pending.lines[0]).toContain("does not know prepared versions yet");
    expect(pending.lines[0]).not.toContain("rotated-under-the-old-schema");
  });

  test("a version written here reads the same after this release migrates", async () => {
    const before = await createSecretVersion(tdb.db, {
      name: "settings.llm.providers.anthropic.api_key",
      value: "carried-across-the-migration",
      created_by: null,
    });
    const { runMigrations } = await import("../../db/migrate.ts");
    await runMigrations(tdb.db);
    expect(await hasPendingSecretColumns(tdb.db)).toBe(true);
    expect(await readSecretVersion(tdb.db, before.name, before.version)).toBe(
      "carried-across-the-migration",
    );
  });
});
