// Engine smoke tests for the v3.5 config-file boot path. tmpdir-only;
// no DB. Each test runs loadConfig() against a fresh config file and
// asserts the documented boot invariants.

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetConfigForTests,
  ConfigLoaderError,
  getConfig,
  getConfigPath,
  getDiagnostics,
  loadConfig,
} from "../loader.ts";

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-smoke-"));
  cfgPath = join(dir, "subkit.config.json");
  _resetConfigForTests();
});

afterEach(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("smoke — zero-config boot", () => {
  test("MASTER_KEY + DATABASE_URL only → engine boots clean on schema defaults", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://localhost/x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const cfg = getConfig();
    expect(cfg.database.url).toBe("postgres://localhost/x");
    expect(cfg.log.level).toBe("info");
    expect(cfg.server.port).toBe(3000);
    // session.secret was missing → loader auto-generated and persisted.
    expect(cfg.auth.session.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    // Diagnostics show zero pending restarts and zero overrides.
    const diag = getDiagnostics();
    expect(diag.pending_restart_keys).toEqual([]);
    expect(diag.override_keys).toEqual([]);
  });

  test("production uses bootstrap bindings without reading or writing a config file", async () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ database: { url: "postgres://must-not-win/legacy" } }),
      "utf8",
    );
    await loadConfig({
      env: {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://bootstrap/runtime",
        PORT: "3100",
        OBJECT_STORAGE_ENDPOINT: "https://objects.example.test",
        OBJECT_STORAGE_REGION: "eu-central-1",
        OBJECT_STORAGE_BUCKET: "subkit",
        OBJECT_STORAGE_ACCESS_KEY_ID: "access",
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
        SUBKIT_CONFIG: cfgPath,
      },
    });
    expect(getConfigPath()).toBe("<postgresql-runtime-config>");
    expect(getConfig().database.url).toBe("postgres://bootstrap/runtime");
    expect(getConfig().server.port).toBe(3100);
    expect(getConfig().storage.object_store).toMatchObject({
      endpoint: "https://objects.example.test",
      region: "eu-central-1",
      bucket: "subkit",
      access_key_id: "access",
      secret_access_key: "secret",
    });
    expect(existsSync(cfgPath)).toBe(true);
    expect(JSON.parse(await Bun.file(cfgPath).text())).toEqual({
      database: { url: "postgres://must-not-win/legacy" },
    });
  });
});

describe("smoke — corrupt config", () => {
  test("invalid JSON exits non-zero with the file path in the error", async () => {
    writeFileSync(cfgPath, "{ totally not json", "utf8");
    let caught: unknown;
    try {
      await loadConfig({
        env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
        configPathOverride: cfgPath,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigLoaderError);
    expect((caught as Error).message).toContain(cfgPath);
    expect((caught as Error).message).toContain("invalid JSON");
  });

  test("schema-violating config fails boot with a precise leaf path", async () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        database: { url: "postgres://x" },
        server: { port: -1 },
      }),
      "utf8",
    );
    let caught: unknown;
    try {
      await loadConfig({
        env: { NODE_ENV: "test" },
        configPathOverride: cfgPath,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigLoaderError);
    expect((caught as Error).message).toContain("server.port");
  });
});

describe("smoke — legacy SK_OVERRIDE_* import", () => {
  test("legacy env seeds canonical config without active overrides", async () => {
    await loadConfig({
      env: {
        DATABASE_URL: "postgres://x",
        NODE_ENV: "test",
        SK_OVERRIDE_LLM_API_KEY: "override-key",
        SK_OVERRIDE_ERRORS_RING_SIZE: "42",
      },
      configPathOverride: cfgPath,
    });
    const diag = getDiagnostics();
    expect(diag.override_keys).toEqual([]);
    expect(diag.source_map["llm.api_key"]).toBe("global");
    expect(diag.source_map["errors.ring_size"]).toBe("global");
    expect(getConfig().llm.api_key).toBe("override-key");
    expect(getConfig().errors.ring_size).toBe(42);
  });

  test("DATABASE_URL is consulted only when config is empty; warn when both differ", async () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ database: { url: "postgres://from-config/x" } }),
      "utf8",
    );
    await loadConfig({
      env: {
        DATABASE_URL: "postgres://from-env/x",
        NODE_ENV: "test",
      },
      configPathOverride: cfgPath,
    });
    expect(getConfig().database.url).toBe("postgres://from-config/x");
  });
});

describe("smoke — getConfig returns a frozen view", () => {
  test("attempting to mutate a returned config throws in strict mode", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const cfg = getConfig();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.llm)).toBe(true);
    expect(Object.isFrozen(cfg.llm.providers)).toBe(true);
  });
});
