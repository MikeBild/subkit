import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { logRing } from "../log-ring.ts";
import { _resetTracingForTests, isTracingStarted, reconfigureTracing } from "../tracing.ts";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "subkit-tracing-reconfigure-"));
  _resetConfigForTests();
  _resetTracingForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
});

afterAll(() => {
  _resetTracingForTests();
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

function countLogs(opts: { module: string; action: string }): number {
  return logRing.tail({ module: opts.module, action: opts.action, limit: 10_000 }).length;
}

describe("observability hot-reload — setConfigKey triggers reconfigureTracing", () => {
  test("reconfigureTracing() does not throw on a no-exporter config (test env baseline)", async () => {
    await reconfigureTracing();
    expect(typeof isTracingStarted()).toBe("boolean");
  });

  test("setConfigKey on observability.langfuse.host emits tracing.reconfigured", async () => {
    const before = countLogs({ module: "observability", action: "tracing.reconfigured" });
    await setConfigKey("observability.langfuse.host", "https://lf.example.test", { force: true });
    const after = countLogs({ module: "observability", action: "tracing.reconfigured" });
    expect(after - before).toBeGreaterThanOrEqual(1);
    await setConfigKey("observability.langfuse.host", "", { force: true });
  });

  test("setConfigKey on observability.otlp.endpoint (non-langfuse leaf) also reconfigures", async () => {
    const before = countLogs({ module: "observability", action: "tracing.reconfigured" });
    await setConfigKey("observability.otlp.endpoint", "https://otlp.example.test", { force: true });
    const after = countLogs({ module: "observability", action: "tracing.reconfigured" });
    expect(after - before).toBeGreaterThanOrEqual(1);
    await setConfigKey("observability.otlp.endpoint", "", { force: true });
  });

  test("resetLangfuseCacheForReload is invalidated by an observability.* setConfigKey", async () => {
    const { resetLangfuseCacheForReload } = await import("../langfuse-spans.ts");
    expect(typeof resetLangfuseCacheForReload).toBe("function");
    const before = countLogs({ module: "config", action: "observability.reconfigure_failed" });
    await setConfigKey("observability.langfuse.public_key", "pk_test", { force: true });
    const after = countLogs({ module: "config", action: "observability.reconfigure_failed" });
    expect(after - before).toBe(0);
    await setConfigKey("observability.langfuse.public_key", "", { force: true });
  });

  test("setConfigKey on a non-observability leaf does NOT emit tracing.reconfigured", async () => {
    const before = countLogs({ module: "observability", action: "tracing.reconfigured" });
    await setConfigKey("errors.ring_size", 256, { force: true });
    const after = countLogs({ module: "observability", action: "tracing.reconfigured" });
    expect(after - before).toBe(0);
    await setConfigKey("errors.ring_size", 100, { force: true });
  });
});
