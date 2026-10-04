import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, getConfig, loadConfig, setConfigKey } from "../loader.ts";

interface CapturedLog {
  module?: string;
  action?: string;
  msg?: string;
  [k: string]: unknown;
}

let dir: string;
let cfgPath: string;
let captured: CapturedLog[];
let restoreStdout: () => void;
let restoreStderr: () => void;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-logs-"));
  cfgPath = join(dir, "subkit.config.json");
  captured = [];

  const { reconfigureLogger } = await import("../../logging/logger.ts");
  reconfigureLogger({ format: "ndjson", level: "info" });

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        captured.push(JSON.parse(trimmed) as CapturedLog);
      } catch {}
    }
    return origStdout(chunk);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        captured.push(JSON.parse(trimmed) as CapturedLog);
      } catch {}
    }
    return origStderr(chunk);
  }) as typeof process.stderr.write;
  restoreStdout = () => {
    process.stdout.write = origStdout as typeof process.stdout.write;
  };
  restoreStderr = () => {
    process.stderr.write = origStderr as typeof process.stderr.write;
  };

  _resetConfigForTests();
});

afterEach(() => {
  restoreStdout();
  restoreStderr();
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

function logLines(filter: (l: CapturedLog) => boolean): CapturedLog[] {
  return captured.filter(filter);
}

describe("config loader — structured logs", () => {
  test("emits config.loaded once on boot with a source tally", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const loaded = logLines((l) => l.module === "config" && l.action === "loaded");
    expect(loaded.length).toBe(1);
    const entry = loaded[0]!;
    expect(entry.config_path).toBe(cfgPath);
    expect(typeof entry.override).toBe("number");
    expect(typeof entry.global).toBe("number");
    expect(typeof entry.default).toBe("number");
    const sum = (entry.override as number) + (entry.global as number) + (entry.default as number);
    expect(sum).toBeGreaterThan(50);
  });

  test("config.loaded fires exactly once across loadConfig + reset + reload", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    expect(logLines((l) => l.module === "config" && l.action === "loaded").length).toBe(1);

    _resetConfigForTests();
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    expect(logLines((l) => l.module === "config" && l.action === "loaded").length).toBe(2);
  });

  test("an SK_OVERRIDE_* environment value never reaches the configuration", async () => {
    await loadConfig({
      env: {
        DATABASE_URL: "postgres://x",
        NODE_ENV: "test",
        SK_OVERRIDE_LLM_API_KEY: "env-value",
      },
      configPathOverride: cfgPath,
    });
    expect(getConfig().llm.api_key).not.toBe("env-value");
  });

  test("emits session-secret auto-gen info line on first boot", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const sessionLine = logLines(
      (l) => l.module === "config" && typeof l.msg === "string" && l.msg.includes("session.secret"),
    );
    expect(sessionLine.length).toBe(1);
  });

  test("emits setting.applied per setConfigKey, with masked metadata only", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    captured.length = 0;

    await setConfigKey("llm.api_key", "sk-secret-test", { force: true });

    const applied = logLines((l) => l.module === "config" && l.action === "setting.applied");
    expect(applied.length).toBe(1);
    const entry = applied[0]!;
    expect(entry.leaf).toBe("llm.api_key");
    expect(entry.scope).toBe("global");
    expect(entry.sensitive).toBe(true);
    expect(entry.requires_restart).toBe(false);
    expect(entry.changed).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("sk-secret-test");
  });

  test("setting.applied scope reflects tenant overlays", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    captured.length = 0;

    await setConfigKey("llm.api_key", "tenant-x-key", {
      tenantId: "tenant-x",
      force: true,
    });
    const applied = logLines((l) => l.action === "setting.applied");
    expect(applied.length).toBe(1);
    expect(applied[0]!.scope).toBe("tenant:tenant-x");
  });

  test("setConfigKey log.level hot-reloads the live logger (no restart needed)", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const { logger, reconfigureLogger } = await import("../../logging/logger.ts");
    reconfigureLogger({ level: "info", format: "ndjson" });
    captured.length = 0;

    logger.debug({ module: "test", msg: "should-not-appear-pre" });
    expect(logLines((l) => l.msg === "should-not-appear-pre").length).toBe(0);

    await setConfigKey("log.level", "debug", { force: true });

    logger.debug({ module: "test", msg: "should-appear-post" });
    expect(logLines((l) => l.msg === "should-appear-post").length).toBe(1);
  });

  test("setting.applied for an unchanged write reports changed:false", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    await setConfigKey("llm.api_key", "kept", { force: true });
    captured.length = 0;
    await setConfigKey("llm.api_key", "kept", { force: true });
    const applied = logLines((l) => l.action === "setting.applied");
    expect(applied.length).toBe(1);
    expect(applied[0]!.changed).toBe(false);
  });
});
