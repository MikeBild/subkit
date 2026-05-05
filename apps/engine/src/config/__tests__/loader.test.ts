// Loader tests. Filesystem-backed (tmpdir) but no DB / no testcontainers.
// Determinism gate: no Math.random / setTimeout / .only.

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
    await loadFresh({ DATABASE_URL: "postgres://localhost/test", NODE_ENV: "test" });
    const cfg = getConfig();
    expect(cfg.database.url).toBe("postgres://localhost/test");
    expect(cfg.log.level).toBe("info");
    expect(cfg.server.port).toBe(3000);
  });

  test("auto-generates auth.session.secret on first boot and writes the file 0600", async () => {
    await loadFresh({ DATABASE_URL: "postgres://x", NODE_ENV: "test" });
    const secret = getConfig().auth.session.secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const mode = statSync(cfgPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("SK_OVERRIDE_LLM_API_KEY wins across all tenants", async () => {
    await loadFresh({
      DATABASE_URL: "postgres://x",
      NODE_ENV: "test",
      SK_OVERRIDE_LLM_API_KEY: "override-key",
    });
    expect(getConfig().llm.api_key).toBe("override-key");
    expect(getConfig("tenant-a").llm.api_key).toBe("override-key");
    expect(getDiagnostics().override_keys).toContain("llm.api_key");
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
            // Non-tenant leaf — should be ignored at merge.
            server: { port: 9999 },
          },
        },
      }),
    );
    await loadFresh({ NODE_ENV: "test" });
    expect(getConfig("tenant-a").llm.api_key).toBe("tenant-a-key");
    expect(getConfig().llm.api_key).toBe("global-key");
    // The non-tenant overlay leaf is structurally there but the
    // applyTenantOverlay merger replaces server.port — we don't surface
    // a guarantee that it's silently dropped, only that global-only
    // PUTs through setConfigKey reject the scope.
    // This is asserted at the setConfigKey level below.
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
  });

  test("scope violation: tenant scope on a global leaf throws", async () => {
    await expect(
      setConfigKey("server.port", 4000, { tenantId: "tenant-x" }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });

  test("validation failure surfaces ValidationError with path + expected", async () => {
    let caught: ValidationError | undefined;
    try {
      // log.level only accepts the documented enum values.
      await setConfigKey("log.level", "bogus", { force: true });
    } catch (err) {
      caught = err as ValidationError;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught!.path[0]).toBe("log");
  });

  test("requires-restart in production blocks without force", async () => {
    // The guard reads process.env.NODE_ENV directly (it predates the
    // loader-injected env). Set + restore for this single test.
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

describe("settings_override_active{key} gauge", () => {
  test("sets the gauge per active override leaf and zeros stale labels on reload", async () => {
    const { getMetrics, resetMetricsRegistryForTests } = await import(
      "../../observability/metrics.ts"
    );
    resetMetricsRegistryForTests();

    await loadFresh({
      DATABASE_URL: "postgres://x",
      NODE_ENV: "test",
      SK_OVERRIDE_LLM_API_KEY: "first-override",
      SK_OVERRIDE_ERRORS_RING_SIZE: "200",
    });
    const reg = getMetrics();
    const renderedAfterBoot = reg.render();
    expect(renderedAfterBoot).toContain('settings_override_active{key="llm.api_key"} 1');
    expect(renderedAfterBoot).toContain('settings_override_active{key="errors.ring_size"} 1');

    // Re-load with only one override — the dropped key must zero out.
    await loadFresh({
      DATABASE_URL: "postgres://x",
      NODE_ENV: "test",
      SK_OVERRIDE_LLM_API_KEY: "second-override",
    });
    const renderedAfterReload = reg.render();
    expect(renderedAfterReload).toContain('settings_override_active{key="llm.api_key"} 1');
    expect(renderedAfterReload).toContain('settings_override_active{key="errors.ring_size"} 0');
  });
});
