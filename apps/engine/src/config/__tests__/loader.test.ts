import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetConfigForTests,
  getConfig,
  getDiagnostics,
  loadConfig,
  RestartRequiredError,
  ScopeViolationError,
  setConfigKey,
  ValidationError,
} from "../loader.ts";

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-"));
  cfgPath = join(dir, "subkit.config.json");
  _resetConfigForTests();
});

afterEach(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

async function loadFresh(env: Record<string, string | undefined>): Promise<void> {
  await loadConfig({ env, configPathOverride: cfgPath });
}

describe("loadConfig", () => {
  test("missing file + DATABASE_URL fallback yields defaults", async () => {
    await loadFresh({
      DATABASE_URL: "postgres://localhost/test",
      NODE_ENV: "test",
    });
    const cfg = getConfig();
    expect(cfg.database.url).toBe("postgres://localhost/test");
    expect(cfg.log.level).toBe("info");
    expect(cfg.server.port).toBe(3000);
  });

  test("Upraft object-storage bootstrap aliases seed revision-one values", async () => {
    await loadFresh({
      DATABASE_URL: "postgres://localhost/test",
      NODE_ENV: "test",
      OBJECT_STORAGE_ENDPOINT: "https://objects.example.test",
      OBJECT_STORAGE_REGION: "garage",
      OBJECT_STORAGE_BUCKET: "private-product",
      OBJECT_STORAGE_ACCESS_KEY_ID: "access",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
      OBJECT_STORAGE_PATH_STYLE: "true",
    });
    expect(getConfig().storage.object_store).toMatchObject({
      endpoint: "https://objects.example.test",
      region: "garage",
      bucket: "private-product",
      access_key_id: "access",
      secret_access_key: "secret",
      force_path_style: true,
    });
  });

  test("conflicting path-style bootstrap aliases fail closed", async () => {
    await expect(
      loadFresh({
        DATABASE_URL: "postgres://localhost/test",
        NODE_ENV: "test",
        OBJECT_STORAGE_PATH_STYLE: "true",
        OBJECT_STORAGE_FORCE_PATH_STYLE: "false",
      }),
    ).rejects.toThrow(/disagree/);
  });

  test("auto-generates auth.session.secret on first boot and writes the file 0600", async () => {
    await loadFresh({ DATABASE_URL: "postgres://x", NODE_ENV: "test" });
    const secret = getConfig().auth.session.secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const mode = statSync(cfgPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("tenant overlay schema rejects non-scope:tenant leaves at parse time", async () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        database: { url: "postgres://x" },
        tenants: {
          "tenant-bad": {
            server: { port: 4001 },
          },
        },
      }),
    );
    await loadFresh({ NODE_ENV: "test" });
    expect(getConfig("tenant-bad").server.port).toBe(3000);
  });

  test("tenant overlay deep-merges and only honors scope:tenant leaves", async () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        database: { url: "postgres://x" },
        llm: { api_key: "global-key" },
        tenants: {
          "tenant-a": {
            llm: { api_key: "tenant-a-key" },
            server: { port: 9999 },
          },
        },
      }),
    );
    await loadFresh({ NODE_ENV: "test" });
    expect(getConfig("tenant-a").llm.api_key).toBe("tenant-a-key");
    expect(getConfig().llm.api_key).toBe("global-key");
  });

  test("invalid JSON file fails with ConfigLoaderError", async () => {
    writeFileSync(cfgPath, "{not valid json");
    await expect(loadFresh({ DATABASE_URL: "postgres://x", NODE_ENV: "test" })).rejects.toThrow(
      /invalid JSON/,
    );
  });
});

describe("setConfigKey", () => {
  beforeEach(async () => {
    await loadFresh({ DATABASE_URL: "postgres://x", NODE_ENV: "test" });
  });

  test("global write updates in-memory and rewrites the file atomically", async () => {
    const r = await setConfigKey("llm.api_key", "new-key");
    expect(r.before).toBe("");
    expect(r.after).toBe("new-key");
    expect(r.scope).toBe("global");
    expect(getConfig().llm.api_key).toBe("new-key");
    const mode = statSync(cfgPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("tenant write isolates per-tenant value", async () => {
    await setConfigKey("llm.api_key", "tenant-key", { tenantId: "tenant-x" });
    expect(getConfig("tenant-x").llm.api_key).toBe("tenant-key");
    expect(getConfig().llm.api_key).toBe("");
    expect(getConfig("tenant-y").llm.api_key).toBe("");
    expect(getDiagnostics().source_map["llm.api_key"]).toBe("default");
  });

  test("scope violation: tenant scope on a global leaf throws", async () => {
    await expect(
      setConfigKey("server.port", 4000, { tenantId: "tenant-x" }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });

  test("the sandbox ceiling is operator-only: a tenant cannot raise sandbox.max_transform_wall_ms", async () => {
    await expect(
      setConfigKey("sandbox.max_transform_wall_ms", 900_000, { tenantId: "tenant-x" }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    const r = await setConfigKey("sandbox.max_transform_wall_ms", 120_000);
    expect(r.after).toBe(120_000);
    expect(getConfig().sandbox.max_transform_wall_ms).toBe(120_000);
  });

  test("validation failure surfaces ValidationError with path + expected", async () => {
    let caught: ValidationError | undefined;
    try {
      await setConfigKey("log.level", "bogus", { force: true });
    } catch (err) {
      caught = err as ValidationError;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught!.path[0]).toBe("log");
  });

  test("requires-restart in production blocks without force", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      _resetConfigForTests();
      await loadConfig({
        env: { DATABASE_URL: "postgres://x", NODE_ENV: "production" },
        configPathOverride: cfgPath,
      });
      await expect(setConfigKey("server.port", 4000)).rejects.toBeInstanceOf(RestartRequiredError);
      const r = await setConfigKey("server.port", 4000, { force: true });
      expect(r.requiresRestart).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  test("unknown leaf path throws ScopeViolationError", async () => {
    await expect(setConfigKey("does.not.exist", "x")).rejects.toBeInstanceOf(ScopeViolationError);
  });

  test("setConfigKey works after a frozen-read (deepFreeze + clone-on-write invariant)", async () => {
    const live = getConfig();
    expect(Object.isFrozen(live)).toBe(true);
    expect(Object.isFrozen(live.llm)).toBe(true);
    const r = await setConfigKey("llm.api_key", "post-freeze-key");
    expect(r.after).toBe("post-freeze-key");
    expect(getConfig().llm.api_key).toBe("post-freeze-key");
  });
});
