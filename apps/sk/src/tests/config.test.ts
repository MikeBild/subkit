// Unit tests for apps/sk/src/config.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, resolveProfile, saveConfig, saveProfile } from "../config.ts";

describe("sk config", () => {
  let tmp: string;
  let path: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sk-config-"));
    path = join(tmp, "config.json");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("loadConfig on missing file returns defaults", () => {
    const cfg = loadConfig(path);
    expect(cfg.active_profile).toBe("default");
    expect(cfg.profiles.default).toBeDefined();
  });

  test("save + load round-trips a multi-profile config", () => {
    const cfg = defaultConfig();
    cfg.profiles.staging = {
      engine_url: "https://staging.example.com",
      api_key: "wf_staging_key",
      active_tenant_id: "t-staging",
      persona_hint: "member",
    };
    cfg.active_profile = "staging";
    saveConfig(cfg, path);
    const loaded = loadConfig(path);
    expect(loaded.active_profile).toBe("staging");
    expect(loaded.profiles.staging?.api_key).toBe("wf_staging_key");
    expect(loaded.profiles.staging?.persona_hint).toBe("member");
  });

  test("non-profile shapes fall back to defaults", () => {
    writeFileSync(
      path,
      JSON.stringify({
        engine_url: "http://localhost:9999",
        api_key: "legacy_key",
        active_tenant_id: "t-legacy",
      }),
    );
    const cfg = loadConfig(path);
    expect(cfg.active_profile).toBe("default");
    expect(cfg.profiles.default?.engine_url).toBe("http://localhost:3000");
    expect(cfg.profiles.default?.api_key).toBe("");
  });

  test("resolveProfile precedence: flag > env > disk > default", () => {
    const cfg = defaultConfig();
    cfg.profiles.default = {
      engine_url: "http://disk.local",
      api_key: "disk_key",
      active_tenant_id: "disk-tenant",
    };
    saveConfig(cfg, path);
    delete process.env.SUBKIT_ENGINE_URL;
    delete process.env.SUBKIT_API_KEY;
    delete process.env.SUBKIT_TENANT;

    // disk wins over defaults
    const fromDisk = resolveProfile({ path });
    expect(fromDisk.engine_url).toBe("http://disk.local");
    expect(fromDisk.api_key).toBe("disk_key");

    // env wins over disk
    process.env.SUBKIT_ENGINE_URL = "http://env.local";
    const fromEnv = resolveProfile({ path });
    expect(fromEnv.engine_url).toBe("http://env.local");

    // flag wins over env
    const fromFlag = resolveProfile({ path, engine_url: "http://flag.local" });
    expect(fromFlag.engine_url).toBe("http://flag.local");

    delete process.env.SUBKIT_ENGINE_URL;
  });

  test("saveProfile updates the named profile and sets it active", () => {
    saveProfile(
      {
        name: "prod",
        engine_url: "https://engine.prod",
        api_key: "prod_key",
        active_tenant_id: "t-prod",
        portal_locked: true,
        persona_hint: "portal",
      },
      path,
    );
    const cfg = loadConfig(path);
    expect(cfg.active_profile).toBe("prod");
    expect(cfg.profiles.prod?.portal_locked).toBe(true);
    expect(cfg.profiles.prod?.persona_hint).toBe("portal");
  });
});
