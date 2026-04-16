// E2E tests for `subkit profile` — multi-profile CRUD, switching,
// resolution precedence, backward compatibility, and config persistence.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, resolveProfile, saveConfig, saveProfile } from "../config.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subkit-profile-"));
  path = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Config shape & persistence
// ---------------------------------------------------------------------------

describe("config shape", () => {
  test("defaultConfig returns multi-profile shape", () => {
    const cfg = defaultConfig();
    expect(cfg.active_profile).toBe("default");
    expect(cfg.profiles).toBeDefined();
    expect(cfg.profiles.default).toBeDefined();
    expect(cfg.profiles.default?.engine_url).toBe("http://localhost:3000");
    expect(cfg.profiles.default?.api_key).toBe("");
    expect(cfg.profiles.default?.active_tenant_id).toBeNull();
  });

  test("save + load roundtrip preserves all fields", () => {
    const cfg = {
      active_profile: "prod",
      profiles: {
        local: {
          engine_url: "http://localhost:3000",
          api_key: "wf_live_local",
          active_tenant_id: "t-local",
        },
        prod: {
          engine_url: "https://api.example.com",
          api_key: "wf_live_prod",
          active_tenant_id: "t-prod",
        },
      },
    };
    saveConfig(cfg, path);
    const loaded = loadConfig(path);
    expect(loaded).toEqual(cfg);
  });

  test("config file has chmod 600", () => {
    if (process.platform === "win32") return;
    saveConfig(defaultConfig(), path);
    const { statSync } = require("node:fs");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("config file is valid JSON", () => {
    saveConfig(defaultConfig(), path);
    const raw = readFileSync(path, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(parsed.active_profile).toBe("default");
    expect(parsed.profiles).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Legacy backward compatibility
// ---------------------------------------------------------------------------

describe("legacy config migration", () => {
  test("flat config auto-wraps as default profile", () => {
    writeFileSync(
      path,
      JSON.stringify({
        engine_url: "http://legacy-host:9090",
        api_key: "old-key-123",
        active_tenant_id: "old-tenant",
      }),
    );
    const loaded = loadConfig(path);
    expect(loaded.active_profile).toBe("default");
    expect(loaded.profiles.default).toBeDefined();
    expect(loaded.profiles.default?.engine_url).toBe("http://legacy-host:9090");
    expect(loaded.profiles.default?.api_key).toBe("old-key-123");
    expect(loaded.profiles.default?.active_tenant_id).toBe("old-tenant");
  });

  test("flat config with only engine_url migrates", () => {
    writeFileSync(path, JSON.stringify({ engine_url: "http://only-url" }));
    const loaded = loadConfig(path);
    expect(loaded.active_profile).toBe("default");
    expect(loaded.profiles.default?.engine_url).toBe("http://only-url");
    expect(loaded.profiles.default?.api_key).toBe("");
  });

  test("flat config with only api_key migrates", () => {
    writeFileSync(path, JSON.stringify({ api_key: "only-key" }));
    const loaded = loadConfig(path);
    expect(loaded.profiles.default?.api_key).toBe("only-key");
    expect(loaded.profiles.default?.engine_url).toBe("http://localhost:3000");
  });

  test("empty JSON object returns default config", () => {
    writeFileSync(path, "{}");
    const loaded = loadConfig(path);
    expect(loaded.active_profile).toBe("default");
    expect(loaded.profiles.default).toBeDefined();
  });

  test("corrupted file returns default config", () => {
    writeFileSync(path, "not json at all {{{");
    const loaded = loadConfig(path);
    expect(loaded).toEqual(defaultConfig());
  });

  test("missing file returns default config", () => {
    const loaded = loadConfig(join(dir, "nonexistent.json"));
    expect(loaded).toEqual(defaultConfig());
  });
});

// ---------------------------------------------------------------------------
// Profile CRUD
// ---------------------------------------------------------------------------

describe("profile CRUD", () => {
  test("saveProfile creates a new named profile", () => {
    saveProfile(
      {
        name: "staging",
        engine_url: "https://staging.example.com",
        api_key: "wf_live_stg",
        active_tenant_id: "t-stg",
      },
      path,
    );
    const loaded = loadConfig(path);
    expect(loaded.active_profile).toBe("staging");
    expect(loaded.profiles.staging).toBeDefined();
    expect(loaded.profiles.staging?.engine_url).toBe("https://staging.example.com");
    expect(loaded.profiles.staging?.api_key).toBe("wf_live_stg");
  });

  test("saveProfile updates an existing profile", () => {
    saveProfile(
      { name: "dev", engine_url: "http://localhost:3000", api_key: "k1", active_tenant_id: null },
      path,
    );
    saveProfile(
      { name: "dev", engine_url: "http://localhost:4000", api_key: "k2", active_tenant_id: "t2" },
      path,
    );
    const loaded = loadConfig(path);
    // "default" is auto-created on first load, "dev" is the one we saved
    expect(loaded.profiles.dev?.engine_url).toBe("http://localhost:4000");
    expect(loaded.profiles.dev?.api_key).toBe("k2");
  });

  test("saveProfile sets active_profile to the saved name", () => {
    saveProfile(
      { name: "alpha", engine_url: "http://a", api_key: "", active_tenant_id: null },
      path,
    );
    saveProfile(
      { name: "beta", engine_url: "http://b", api_key: "", active_tenant_id: null },
      path,
    );
    const loaded = loadConfig(path);
    expect(loaded.active_profile).toBe("beta");
    expect(Object.keys(loaded.profiles)).toContain("alpha");
    expect(Object.keys(loaded.profiles)).toContain("beta");
  });

  test("multiple profiles coexist independently", () => {
    saveProfile(
      {
        name: "local",
        engine_url: "http://localhost:3000",
        api_key: "k-local",
        active_tenant_id: null,
      },
      path,
    );
    saveProfile(
      {
        name: "prod",
        engine_url: "https://prod.example.com",
        api_key: "k-prod",
        active_tenant_id: "t-prod",
      },
      path,
    );
    saveProfile(
      {
        name: "staging",
        engine_url: "https://staging.example.com",
        api_key: "k-stg",
        active_tenant_id: "t-stg",
      },
      path,
    );
    const loaded = loadConfig(path);
    // default + local + prod + staging
    expect(loaded.profiles.local?.api_key).toBe("k-local");
    expect(loaded.profiles.prod?.api_key).toBe("k-prod");
    expect(loaded.profiles.staging?.api_key).toBe("k-stg");
  });

  test("deleting a profile via saveConfig", () => {
    saveProfile({ name: "a", engine_url: "http://a", api_key: "ka", active_tenant_id: null }, path);
    saveProfile({ name: "b", engine_url: "http://b", api_key: "kb", active_tenant_id: null }, path);
    const cfg = loadConfig(path);
    delete cfg.profiles.a;
    if (cfg.active_profile === "a") {
      cfg.active_profile = Object.keys(cfg.profiles)[0] ?? "default";
    }
    saveConfig(cfg, path);
    const reloaded = loadConfig(path);
    expect(Object.keys(reloaded.profiles)).not.toContain("a");
    expect(Object.keys(reloaded.profiles)).toContain("b");
  });

  test("switching active profile preserves all profiles", () => {
    saveProfile(
      { name: "local", engine_url: "http://localhost:3000", api_key: "k1", active_tenant_id: null },
      path,
    );
    saveProfile(
      {
        name: "prod",
        engine_url: "https://prod.example.com",
        api_key: "k2",
        active_tenant_id: null,
      },
      path,
    );
    // Switch back to local
    const cfg = loadConfig(path);
    cfg.active_profile = "local";
    saveConfig(cfg, path);
    const reloaded = loadConfig(path);
    expect(reloaded.active_profile).toBe("local");
    expect(Object.keys(reloaded.profiles)).toContain("local");
    expect(Object.keys(reloaded.profiles)).toContain("prod");
    expect(reloaded.profiles.prod?.api_key).toBe("k2");
  });
});

// ---------------------------------------------------------------------------
// Profile resolution precedence
// ---------------------------------------------------------------------------

describe("resolveProfile precedence", () => {
  test("explicit flags override disk values", () => {
    saveProfile(
      {
        name: "default",
        engine_url: "http://disk",
        api_key: "disk-key",
        active_tenant_id: "disk-t",
      },
      path,
    );
    const resolved = resolveProfile({
      path,
      engine_url: "http://flag",
      api_key: "flag-key",
      tenant: "flag-t",
    });
    expect(resolved.engine_url).toBe("http://flag");
    expect(resolved.api_key).toBe("flag-key");
    expect(resolved.active_tenant_id).toBe("flag-t");
  });

  test("disk values used when no flags", () => {
    saveProfile(
      {
        name: "default",
        engine_url: "http://disk",
        api_key: "disk-key",
        active_tenant_id: "disk-t",
      },
      path,
    );
    const resolved = resolveProfile({ path });
    expect(resolved.engine_url).toBe("http://disk");
    expect(resolved.api_key).toBe("disk-key");
    expect(resolved.active_tenant_id).toBe("disk-t");
  });

  test("profile flag selects a named profile", () => {
    saveProfile(
      {
        name: "local",
        engine_url: "http://local:3000",
        api_key: "k-local",
        active_tenant_id: null,
      },
      path,
    );
    saveProfile(
      {
        name: "prod",
        engine_url: "https://prod.example.com",
        api_key: "k-prod",
        active_tenant_id: "t-prod",
      },
      path,
    );
    // Active is "prod", but we request "local"
    const resolved = resolveProfile({ path, profile: "local" });
    expect(resolved.name).toBe("local");
    expect(resolved.engine_url).toBe("http://local:3000");
    expect(resolved.api_key).toBe("k-local");
  });

  test("profile flag + engine_url flag: flag wins for url", () => {
    saveProfile(
      {
        name: "prod",
        engine_url: "https://prod.example.com",
        api_key: "k-prod",
        active_tenant_id: null,
      },
      path,
    );
    const resolved = resolveProfile({
      path,
      profile: "prod",
      engine_url: "https://override.example.com",
    });
    expect(resolved.engine_url).toBe("https://override.example.com");
    expect(resolved.api_key).toBe("k-prod");
  });

  test("unknown profile name falls back to defaults", () => {
    saveProfile(
      { name: "existing", engine_url: "http://exists", api_key: "k1", active_tenant_id: null },
      path,
    );
    const resolved = resolveProfile({ path, profile: "nonexistent" });
    expect(resolved.name).toBe("nonexistent");
    expect(resolved.engine_url).toBe("http://localhost:3000");
    expect(resolved.api_key).toBe("");
  });

  test("defaults used when file missing", () => {
    const resolved = resolveProfile({ path: join(dir, "missing.json") });
    expect(resolved.name).toBe("default");
    expect(resolved.engine_url).toBe("http://localhost:3000");
    expect(resolved.api_key).toBe("");
    expect(resolved.active_tenant_id).toBeNull();
  });

  test("partial flag override — only engine_url", () => {
    saveProfile(
      {
        name: "default",
        engine_url: "http://disk",
        api_key: "disk-key",
        active_tenant_id: "disk-t",
      },
      path,
    );
    const resolved = resolveProfile({ path, engine_url: "http://override" });
    expect(resolved.engine_url).toBe("http://override");
    expect(resolved.api_key).toBe("disk-key");
    expect(resolved.active_tenant_id).toBe("disk-t");
  });

  test("empty string flags are ignored (fall through to disk)", () => {
    saveProfile(
      { name: "default", engine_url: "http://disk", api_key: "disk-key", active_tenant_id: null },
      path,
    );
    const resolved = resolveProfile({
      path,
      engine_url: "",
      api_key: "  ",
      tenant: "",
    });
    expect(resolved.engine_url).toBe("http://disk");
    expect(resolved.api_key).toBe("disk-key");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("profile name with special characters", () => {
    saveProfile(
      { name: "my-prod-v2", engine_url: "http://v2", api_key: "k", active_tenant_id: null },
      path,
    );
    const loaded = loadConfig(path);
    expect(loaded.profiles["my-prod-v2"]).toBeDefined();
    const resolved = resolveProfile({ path, profile: "my-prod-v2" });
    expect(resolved.engine_url).toBe("http://v2");
  });

  test("profile with empty api_key", () => {
    saveProfile(
      { name: "nokey", engine_url: "http://nokey", api_key: "", active_tenant_id: null },
      path,
    );
    const resolved = resolveProfile({ path, profile: "nokey" });
    expect(resolved.api_key).toBe("");
  });

  test("many profiles (10+)", () => {
    for (let i = 0; i < 15; i++) {
      saveProfile(
        {
          name: `env-${i}`,
          engine_url: `http://env-${i}:3000`,
          api_key: `k-${i}`,
          active_tenant_id: null,
        },
        path,
      );
    }
    const loaded = loadConfig(path);
    // 15 named + 1 auto-created "default" = 16
    expect(Object.keys(loaded.profiles).length).toBeGreaterThanOrEqual(15);
    expect(loaded.active_profile).toBe("env-14");
    const resolved = resolveProfile({ path, profile: "env-7" });
    expect(resolved.engine_url).toBe("http://env-7:3000");
  });

  test("saveConfig creates parent directories", () => {
    const nested = join(dir, "a", "b", "c", "config.json");
    saveConfig(defaultConfig(), nested);
    const loaded = loadConfig(nested);
    expect(loaded.active_profile).toBe("default");
  });

  test("resolveProfile returns name field", () => {
    saveProfile(
      { name: "myprofile", engine_url: "http://x", api_key: "k", active_tenant_id: null },
      path,
    );
    const resolved = resolveProfile({ path, profile: "myprofile" });
    expect(resolved.name).toBe("myprofile");
  });
});
