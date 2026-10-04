import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../settings.ts";

describe("sk settings loader", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sk-settings-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns defaults when no files exist", () => {
    const r = loadSettings(tmp);
    expect(r.sources).toEqual([]);
    expect(r.merged.includeMemoryFile).toBe(true);
    expect(r.merged.statusLine?.showTokens).toBe(true);
  });

  test("project settings override defaults and surface sources", () => {
    mkdirSync(join(tmp, ".sk"), { recursive: true });
    writeFileSync(
      join(tmp, ".sk", "settings.json"),
      JSON.stringify({ includeMemoryFile: false, model: "claude-opus-4-6" }),
    );
    const r = loadSettings(tmp);
    expect(r.merged.includeMemoryFile).toBe(false);
    expect(r.merged.model).toBe("claude-opus-4-6");
    expect(r.sources.some((s) => s.endsWith("settings.json"))).toBe(true);
  });

  test("local settings take precedence over project settings", () => {
    mkdirSync(join(tmp, ".sk"), { recursive: true });
    writeFileSync(
      join(tmp, ".sk", "settings.json"),
      JSON.stringify({ model: "from-project", additionalDirectories: ["src"] }),
    );
    writeFileSync(join(tmp, ".sk", "settings.local.json"), JSON.stringify({ model: "from-local" }));
    const r = loadSettings(tmp);
    expect(r.merged.model).toBe("from-local");
    expect(r.merged.additionalDirectories).toEqual(["src"]);
  });

  test("malformed JSON is tolerated and falls back to defaults", () => {
    mkdirSync(join(tmp, ".sk"), { recursive: true });
    writeFileSync(join(tmp, ".sk", "settings.json"), "{ not valid");
    const r = loadSettings(tmp);
    expect(r.merged.includeMemoryFile).toBe(true);
  });
});
