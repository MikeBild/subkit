// Hot-reload contract: setConfigKey on an `observability.*` leaf must
// call reconfigureTracing() and reset the langfuse-spans cache.
//
// Without this regression net a future schema rename of the
// `observability` group would silently break the hot-reload trigger
// in setConfigKey() (`leaf.path[0] === "observability"`); the only
// signal would be operator confusion that "I set
// observability.langfuse.secret_key but spans still go to the old
// project". We assert via the structured-logger surface that
// `tracing.reconfigured` fires for an observability leaf and does NOT
// fire for an unrelated leaf — observable without booting the OTel
// SDK (which the test env can't usefully exercise — no exporter is
// configured).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { isTracingStarted, reconfigureTracing } from "../tracing.ts";

interface CapturedLog {
  module?: string;
  action?: string;
  msg?: string;
  [k: string]: unknown;
}

let dir: string;
let captured: CapturedLog[];
let restoreStdout: () => void;

function attachStdoutCapture(buf: CapturedLog[]): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        buf.push(JSON.parse(trimmed) as CapturedLog);
      } catch {
        /* not a JSON line */
      }
    }
    return orig(chunk);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig as typeof process.stdout.write;
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "subkit-tracing-reconfigure-"));
  captured = [];
  restoreStdout = attachStdoutCapture(captured);
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
});

afterAll(() => {
  restoreStdout?.();
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("observability hot-reload — setConfigKey triggers reconfigureTracing", () => {
  test("reconfigureTracing() does not throw on a no-exporter config (test env baseline)", async () => {
    // Test env has no exporter configured — startTracing() short-circuits
    // and reconfigureTracing() should still complete cleanly.
    await reconfigureTracing();
    expect(typeof isTracingStarted()).toBe("boolean");
  });

  test("setConfigKey on observability.langfuse.host emits tracing.reconfigured", async () => {
    captured.length = 0;
    await setConfigKey("observability.langfuse.host", "https://lf.example.test", { force: true });
    // The hot-reload block in setConfigKey() awaits reconfigureTracing()
    // which logs `tracing.reconfigured` on completion.
    const reconfigured = captured.filter(
      (l) => l.module === "observability" && l.action === "tracing.reconfigured",
    );
    expect(reconfigured.length).toBeGreaterThanOrEqual(1);
    await setConfigKey("observability.langfuse.host", "", { force: true });
  });

  test("setConfigKey on a non-observability leaf does NOT emit tracing.reconfigured", async () => {
    captured.length = 0;
    await setConfigKey("errors.ring_size", 256, { force: true });
    const reconfigured = captured.filter(
      (l) => l.module === "observability" && l.action === "tracing.reconfigured",
    );
    expect(reconfigured.length).toBe(0);
    await setConfigKey("errors.ring_size", 100, { force: true });
  });
});
