// Config file roundtrip: save + load + resolve precedence.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, resolveConfig, saveConfig } from "../config.ts";

describe("config", () => {
  test("save + load roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "subkit-"));
    const path = join(dir, "config.json");
    try {
      const cfg = {
        active_profile: "default",
        profiles: {
          default: {
            engine_url: "https://engine.example.com",
            api_key: "k1",
            active_tenant_id: "t1",
          },
        },
      };
      saveConfig(cfg, path);
      const back = loadConfig(path);
      expect(back).toEqual(cfg);
      // File must be readable + not group-readable on unix.
      const mode = statSync(path).mode & 0o777;
      if (process.platform !== "win32") {
        expect(mode).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy flat config auto-migrates to profiles", () => {
    const dir = mkdtempSync(join(tmpdir(), "subkit-"));
    const path = join(dir, "config.json");
    try {
      // Write a legacy flat config directly
      const { writeFileSync } = require("node:fs");
      writeFileSync(
        path,
        JSON.stringify({
          engine_url: "http://legacy",
          api_key: "legacy-key",
          active_tenant_id: "legacy-tenant",
        }),
      );
      const loaded = loadConfig(path);
      expect(loaded.active_profile).toBe("default");
      expect(loaded.profiles.default?.engine_url).toBe("http://legacy");
      expect(loaded.profiles.default?.api_key).toBe("legacy-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolve precedence: flag > env > disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "subkit-"));
    const path = join(dir, "config.json");
    try {
      saveConfig(
        {
          active_profile: "default",
          profiles: {
            default: {
              engine_url: "http://disk",
              api_key: "disk-key",
              active_tenant_id: "disk-tenant",
            },
          },
        },
        path,
      );
      const resolved = resolveConfig({
        path,
        engine_url: "http://flag",
        api_key: undefined,
      });
      expect(resolved.engine_url).toBe("http://flag");
      expect(resolved.api_key).toBe("disk-key");
      expect(resolved.active_tenant_id).toBe("disk-tenant");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("defaultConfig when file missing", () => {
    const resolved = loadConfig(join(tmpdir(), "does-not-exist-subkit.json"));
    expect(resolved).toEqual(defaultConfig());
  });
});
