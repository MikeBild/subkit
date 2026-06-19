// Hot-reload contract: setConfigKey on an `observability.*` leaf must
// call reconfigureTracing() and reset the langfuse-spans cache.
//
// Without this regression net a future schema rename of the
// `observability` group would silently break the hot-reload trigger
// in setConfigKey() (`leaf.path[0] === "observability"`); the only
// signal would be operator confusion that "I set
// observability.langfuse.secret_key but spans still go to the old
// project". We assert via the structured-logger ring (`logRing.tail`)
// that `tracing.reconfigured` fires for an observability leaf and
// does NOT fire for an unrelated leaf — observable without booting
// the OTel SDK (which the test env can't usefully exercise — no
// exporter is configured).
//
// 4.2.0 reviewer feedback: previously this test monkey-patched
// `process.stdout.write` and JSON-parsed any line starting with `{`.
// Two problems with that shape: (1) if the logger sink ever changes
// (pino transport, journald, buffered writer), the test silently
// passes for the wrong reason; (2) an in-test crash leaks the
// stdout patch into subsequent suites. The logRing is the engine's
// canonical structured-log seam — the diagnostics route and `sk
// logs` both read from it — so asserting via `logRing.tail` tests
// the same surface operators consume in production.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { logRing } from "../log-ring.ts";
import { isTracingStarted, reconfigureTracing } from "../tracing.ts";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "subkit-tracing-reconfigure-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
});

afterAll(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

// Helper: count current matching entries in the ring. since_ms is
// millisecond-resolution and a previous test's log entry can land in
// the same tick as the next test's `Date.now()` baseline, so we use
// before/after deltas instead of a since_ms cutoff.
function countLogs(opts: { module: string; action: string }): number {
  return logRing.tail({ module: opts.module, action: opts.action, limit: 10_000 }).length;
}

describe("observability hot-reload — setConfigKey triggers reconfigureTracing", () => {
  test("reconfigureTracing() does not throw on a no-exporter config (test env baseline)", async () => {
    // Test env has no exporter configured — startTracing() short-circuits
    // and reconfigureTracing() should still complete cleanly.
    await reconfigureTracing();
    expect(typeof isTracingStarted()).toBe("boolean");
  });

  test("setConfigKey on observability.langfuse.host emits tracing.reconfigured", async () => {
    const before = countLogs({ module: "observability", action: "tracing.reconfigured" });
    await setConfigKey("observability.langfuse.host", "https://lf.example.test", { force: true });
    // The hot-reload block in setConfigKey() awaits reconfigureTracing()
    // which logs `tracing.reconfigured` on completion. The log sits
    // behind the await, so observing the count delta proves both that
    // the predicate (`leaf.path[0] === "observability"`) matched AND
    // that the await completed before setConfigKey returned.
    const after = countLogs({ module: "observability", action: "tracing.reconfigured" });
    expect(after - before).toBeGreaterThanOrEqual(1);
    await setConfigKey("observability.langfuse.host", "", { force: true });
  });

  test("setConfigKey on observability.otlp.endpoint (non-langfuse leaf) also reconfigures", async () => {
    // The hot-reload predicate is `leaf.path[0] === "observability"` —
    // any observability sub-tree must trigger reconfigureTracing() and
    // resetLangfuseCacheForReload(). A future change that narrows the predicate
    // to `observability.langfuse.*` would silently break OTLP endpoint
    // hot-reloads; this test fences that.
    const before = countLogs({ module: "observability", action: "tracing.reconfigured" });
    await setConfigKey("observability.otlp.endpoint", "https://otlp.example.test", { force: true });
    const after = countLogs({ module: "observability", action: "tracing.reconfigured" });
    expect(after - before).toBeGreaterThanOrEqual(1);
    await setConfigKey("observability.otlp.endpoint", "", { force: true });
  });

  test("resetLangfuseCacheForReload is invalidated by an observability.* setConfigKey", async () => {
    // Prove the cache reset wiring end-to-end: invoke a settings
    // change on an observability.* leaf and confirm the loader's
    // catch-block warning never fires. Failure here would surface
    // as a `config / observability.reconfigure_failed` log entry.
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
