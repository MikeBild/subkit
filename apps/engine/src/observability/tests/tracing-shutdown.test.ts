import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const instances: FakeSDK[] = [];
class FakeSDK {
  entered = Promise.withResolvers<void>();
  completion = Promise.withResolvers<void>();
  calls = 0;
  constructor() {
    instances.push(this);
  }
  start() {}
  shutdown() {
    this.calls++;
    this.entered.resolve();
    return this.completion.promise;
  }
}
mock.module("@opentelemetry/sdk-node", () => ({
  NodeSDK: FakeSDK,
  tracing: { BatchSpanProcessor: class {} },
}));
mock.module("@opentelemetry/exporter-trace-otlp-http", () => ({ OTLPTraceExporter: class {} }));
const { _resetConfigForTests, loadConfig } = await import("../../config/loader.ts");
const { startTracing, reconfigureTracing, isTracingActive, _resetTracingForTests } = await import(
  "../tracing.ts"
);

test("captured finalizer drains a reconfigured SDK and retains its actual shutdown failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subkit-tracing-shutdown-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({ observability: { otlp: { endpoint: "https://telemetry.example" } } }),
  );
  _resetConfigForTests();
  _resetTracingForTests();
  instances.length = 0;
  try {
    await loadConfig({
      env: { DATABASE_URL: "postgres://fixture", NODE_ENV: "test" },
      configPathOverride: path,
    });
    const finalizer = await startTracing();
    const first = instances[0];
    if (!first) throw new Error("tracing_fixture_missing");
    const changing = reconfigureTracing();
    await first.entered.promise;
    const closing = finalizer();
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    first.completion.resolve();
    await changing;
    const current = instances[1];
    if (!current) throw new Error("tracing_fixture_missing");
    await current.entered.promise;
    expect(first.calls).toBe(1);
    expect(current.calls).toBe(1);
    expect(settled).toBe(false);
    current.completion.reject(new Error("synthetic_exporter_failure"));
    await expect(closing).rejects.toThrow("tracing_shutdown_failed");
    expect(isTracingActive()).toBe(false);
    expect(finalizer()).toBe(closing);
    await expect(startTracing()).rejects.toThrow("tracing_stopping");
    await expect(reconfigureTracing()).rejects.toThrow("tracing_stopping");
  } finally {
    _resetTracingForTests();
    _resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
