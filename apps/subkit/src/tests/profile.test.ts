import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialSessionState } from "@cli-core/index.ts";
import { defaultConfig, loadConfig, resolveProfile, saveConfig, saveProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { handleSlash } from "../repl/slash/handler.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subkit-profile-"));
  path = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("subkit config shape", () => {
  test("defaultConfig returns multi-profile shape", () => {
    const cfg = defaultConfig();
    expect(cfg.active_profile).toBe("default");
    expect(cfg.profiles.default).toBeDefined();
    expect(cfg.profiles.default?.engine_url).toBe("http://localhost:3000");
  });

  test("save + load roundtrip with multiple profiles", () => {
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
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("subkit config fallbacks", () => {
  test("flat config shape falls back to the default profile set", () => {
    writeFileSync(
      path,
      JSON.stringify({
        engine_url: "http://old-engine:8080",
        api_key: "old-key",
        active_tenant_id: "old-t",
      }),
    );
    const loaded = loadConfig(path);
    expect(loaded.active_profile).toBe("default");
    expect(loaded.profiles.default?.engine_url).toBe("http://localhost:3000");
    expect(loaded.profiles.default?.api_key).toBe("");
  });

  test("corrupted JSON returns default config", () => {
    writeFileSync(path, "{{invalid");
    expect(loadConfig(path)).toEqual(defaultConfig());
  });

  test("missing file returns default config", () => {
    expect(loadConfig(join(dir, "nope.json"))).toEqual(defaultConfig());
  });
});

describe("subkit profile CRUD", () => {
  test("saveProfile creates named profile and sets it active", () => {
    saveProfile(
      {
        name: "staging",
        engine_url: "https://stg.example.com",
        api_key: "k-stg",
        active_tenant_id: null,
      },
      path,
    );
    const loaded = loadConfig(path);
    expect(loaded.active_profile).toBe("staging");
    expect(loaded.profiles.staging?.engine_url).toBe("https://stg.example.com");
  });

  test("saveProfile updates existing profile in place", () => {
    saveProfile(
      { name: "dev", engine_url: "http://old", api_key: "k1", active_tenant_id: null },
      path,
    );
    saveProfile(
      { name: "dev", engine_url: "http://new", api_key: "k2", active_tenant_id: "t2" },
      path,
    );
    const loaded = loadConfig(path);
    expect(loaded.profiles.dev?.engine_url).toBe("http://new");
    expect(loaded.profiles.dev?.api_key).toBe("k2");
  });

  test("multiple profiles coexist", () => {
    for (const name of ["local", "staging", "prod"]) {
      saveProfile(
        { name, engine_url: `http://${name}`, api_key: `k-${name}`, active_tenant_id: null },
        path,
      );
    }
    const loaded = loadConfig(path);
    expect(Object.keys(loaded.profiles)).toContain("local");
    expect(Object.keys(loaded.profiles)).toContain("staging");
    expect(Object.keys(loaded.profiles)).toContain("prod");
  });

  test("delete profile and adjust active", () => {
    saveProfile({ name: "a", engine_url: "http://a", api_key: "ka", active_tenant_id: null }, path);
    saveProfile({ name: "b", engine_url: "http://b", api_key: "kb", active_tenant_id: null }, path);
    const cfg = loadConfig(path);
    delete cfg.profiles.b;
    cfg.active_profile = "a";
    saveConfig(cfg, path);
    const reloaded = loadConfig(path);
    expect(reloaded.active_profile).toBe("a");
    expect(Object.keys(reloaded.profiles)).toContain("a");
    expect(Object.keys(reloaded.profiles)).not.toContain("b");
  });
});

describe("subkit resolveProfile", () => {
  test("flags override disk", () => {
    saveProfile(
      { name: "default", engine_url: "http://disk", api_key: "dk", active_tenant_id: "dt" },
      path,
    );
    const r = resolveProfile({ path, engine_url: "http://flag", api_key: "fk", tenant: "ft" });
    expect(r.engine_url).toBe("http://flag");
    expect(r.api_key).toBe("fk");
    expect(r.active_tenant_id).toBe("ft");
  });

  test("profile flag selects named profile", () => {
    saveProfile(
      { name: "local", engine_url: "http://local", api_key: "kl", active_tenant_id: null },
      path,
    );
    saveProfile(
      { name: "prod", engine_url: "https://prod", api_key: "kp", active_tenant_id: "tp" },
      path,
    );
    const r = resolveProfile({ path, profile: "local" });
    expect(r.name).toBe("local");
    expect(r.engine_url).toBe("http://local");
  });

  test("unknown profile returns defaults", () => {
    const r = resolveProfile({ path, profile: "ghost" });
    expect(r.name).toBe("ghost");
    expect(r.engine_url).toBe("http://localhost:3000");
    expect(r.api_key).toBe("");
  });

  test("empty string flags ignored", () => {
    saveProfile(
      { name: "default", engine_url: "http://disk", api_key: "dk", active_tenant_id: null },
      path,
    );
    const r = resolveProfile({ path, engine_url: "", api_key: "   " });
    expect(r.engine_url).toBe("http://disk");
    expect(r.api_key).toBe("dk");
  });
});

describe("/profile slash handler", () => {
  function mockCtx(configPath: string) {
    return {
      client: {} as unknown as EngineClient,
      profile: resolveProfile({ path: configPath }),
      session: initialSessionState(null),
      setConversationId: () => {},
      allowedPermissions: [] as readonly string[],
      configPath,
    };
  }

  test("/profile with no args lists profiles", async () => {
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
    const _origHome = process.env.HOME;
    const result = await handleSlash("profile", [], {
      ...mockCtx(path),
    });
    expect(result).toBeDefined();
    expect(result).toContain("profiles:");
    expect(result).toContain("local");
    expect(result).toContain("prod");
    expect(result).toContain("/profile <name> to switch");
  });

  test("/profile <name> with unknown name returns error", async () => {
    saveProfile(
      { name: "local", engine_url: "http://localhost:3000", api_key: "k1", active_tenant_id: null },
      path,
    );
    const result = await handleSlash("profile", ["nonexistent"], mockCtx(path));
    expect(result).toContain("not found");
  });

  test("/profile add redirects outside REPL", async () => {
    const result = await handleSlash("profile", ["add"], mockCtx(path));
    expect(result).toContain("outside the REPL");
  });

  test("/env alias works", async () => {
    saveProfile(
      {
        name: "default",
        engine_url: "http://localhost:3000",
        api_key: "k",
        active_tenant_id: null,
      },
      path,
    );
    const result = await handleSlash("env", [], mockCtx(path));
    expect(result).toContain("profiles:");
  });

  test("/profile <name> with switchProfile callback switches", async () => {
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
    let switchedTo: string | undefined;
    const result = await handleSlash("profile", ["local"], {
      ...mockCtx(path),
      switchProfile: async (name: string) => {
        switchedTo = name;
        return `switched to "${name}"`;
      },
    });
    expect(switchedTo).toBe("local");
    expect(result).toContain("switched");
  });
});

describe("subkit edge cases", () => {
  test("persona_hint and portal_locked preserved", () => {
    saveProfile(
      {
        name: "portal",
        engine_url: "http://portal",
        api_key: "k",
        active_tenant_id: "t",
        persona_hint: "portal",
        portal_locked: true,
      },
      path,
    );
    const loaded = loadConfig(path);
    expect(loaded.profiles.portal?.persona_hint).toBe("portal");
    expect(loaded.profiles.portal?.portal_locked).toBe(true);
  });

  test("15 profiles stress test", () => {
    for (let i = 0; i < 15; i++) {
      saveProfile(
        { name: `env${i}`, engine_url: `http://env${i}`, api_key: `k${i}`, active_tenant_id: null },
        path,
      );
    }
    const loaded = loadConfig(path);
    expect(Object.keys(loaded.profiles).length).toBeGreaterThanOrEqual(15);
    const r = resolveProfile({ path, profile: "env7" });
    expect(r.engine_url).toBe("http://env7");
  });
});
