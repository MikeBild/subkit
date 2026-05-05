// Runtime-log assertions for the v3.5+ structured-log surface added in
// audit pass 6:
//
//   - config.boot.complete                      (one per boot, lists consumers)
//   - config.requires_restart_pending           (warn per call, lists pending leaves)
//   - config.tenant_overlay.applied             (covered indirectly via setting.applied scope)
//
// Each test captures stdout, drives the loader, and asserts the line
// fires once with the expected shape. Catches drift in the operator-
// observable contract.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetBootConsumersForTests,
  _resetConfigForTests,
  emitBootComplete,
  emitRequiresRestartPendingIfAny,
  loadConfig,
  recordBootConsumer,
  setConfigKey,
} from "../loader.ts";
import { dottedPath, listConfigLeaves } from "../walk.ts";

interface Cap {
  module?: string;
  action?: string;
  consumers?: string[];
  consumer_count?: number;
  pending_restart_keys?: string[];
  pending_count?: number;
  [k: string]: unknown;
}

let dir: string;
let cfgPath: string;
let captured: Cap[];
let restoreStdout: () => void;

function attach(buf: Cap[]): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        buf.push(JSON.parse(t));
      } catch {
        /* not JSON */
      }
    }
    return orig(chunk);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig as typeof process.stdout.write;
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-runtime-logs-"));
  cfgPath = join(dir, "subkit.config.json");
  captured = [];
  const { reconfigureLogger } = await import("../../logging/logger.ts");
  reconfigureLogger({ level: "info", format: "ndjson" });
  restoreStdout = attach(captured);
  _resetConfigForTests();
  _resetBootConsumersForTests();
});

afterEach(() => {
  restoreStdout();
  _resetConfigForTests();
  _resetBootConsumersForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("config.boot.complete", () => {
  test("fires exactly once after recordBootConsumer + emitBootComplete", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    recordBootConsumer("logger");
    recordBootConsumer("queue");
    recordBootConsumer("http_server");
    captured.length = 0;
    await emitBootComplete();
    const lines = captured.filter((l) => l.module === "config" && l.action === "boot.complete");
    expect(lines.length).toBe(1);
    expect(lines[0]?.consumers).toEqual(["http_server", "logger", "queue"]);
    expect(lines[0]?.consumer_count).toBe(3);
  });

  test("subsequent emitBootComplete calls are no-ops (idempotent)", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    recordBootConsumer("logger");
    captured.length = 0;
    await emitBootComplete();
    await emitBootComplete();
    await emitBootComplete();
    const lines = captured.filter((l) => l.module === "config" && l.action === "boot.complete");
    expect(lines.length).toBe(1);
  });

  test("recordBootConsumer after emit is dropped (boot is sealed)", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    recordBootConsumer("logger");
    await emitBootComplete();
    captured.length = 0;
    recordBootConsumer("late_arrival");
    // Re-arming the emit doesn't add the late consumer because we're sealed.
    await emitBootComplete();
    const lines = captured.filter((l) => l.module === "config" && l.action === "boot.complete");
    expect(lines.length).toBe(0);
  });
});

describe("config.requires_restart_pending", () => {
  test("no-op when no requiresRestart leaves are pending", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    captured.length = 0;
    await emitRequiresRestartPendingIfAny();
    const lines = captured.filter(
      (l) => l.module === "config" && l.action === "requires_restart_pending",
    );
    expect(lines.length).toBe(0);
  });

  test("fires once when a requiresRestart leaf has been written; lists the leaf", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    await setConfigKey("server.port", 4500, { force: true });
    captured.length = 0;
    await emitRequiresRestartPendingIfAny();
    const lines = captured.filter(
      (l) => l.module === "config" && l.action === "requires_restart_pending",
    );
    expect(lines.length).toBe(1);
    expect(lines[0]?.pending_restart_keys).toContain("server.port");
    expect(lines[0]?.pending_count).toBeGreaterThanOrEqual(1);
  });

  test("re-firing produces the same warn (idempotent reminder cadence)", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    await setConfigKey("server.port", 4501, { force: true });
    captured.length = 0;
    await emitRequiresRestartPendingIfAny();
    await emitRequiresRestartPendingIfAny();
    const lines = captured.filter(
      (l) => l.module === "config" && l.action === "requires_restart_pending",
    );
    expect(lines.length).toBe(2);
  });
});

describe("schema description hygiene", () => {
  test("no leaf description contains a newline (would break settings-reference.md table)", () => {
    const badly: string[] = [];
    for (const leaf of listConfigLeaves()) {
      const d = leaf.description;
      if (d && /\n/.test(d)) badly.push(`${dottedPath(leaf)}: ${JSON.stringify(d.slice(0, 60))}`);
    }
    expect(badly, `leaf descriptions with embedded newlines:\n${badly.join("\n")}`).toEqual([]);
  });

  test("no leaf description exceeds 200 chars (operator UX, doc-table cell)", () => {
    const long: string[] = [];
    for (const leaf of listConfigLeaves()) {
      const d = leaf.description;
      if (d && d.length > 200) long.push(`${dottedPath(leaf)}: ${d.length} chars`);
    }
    expect(long).toEqual([]);
  });
});
