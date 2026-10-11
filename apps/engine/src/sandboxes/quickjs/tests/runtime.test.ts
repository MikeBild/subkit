import { describe, expect, test } from "bun:test";
import { withContext } from "../../../logging/context.ts";
import { assertBoundedWorkerValue, runJs } from "../runtime.ts";
import {
  SandboxInterruptError,
  SandboxMemoryError,
  SandboxRuntimeError,
  SandboxTimeoutError,
} from "../types.ts";

describe("quickjs runtime", () => {
  test("rejects oversized and cyclic worker values before serialization", () => {
    expect(() => assertBoundedWorkerValue({ nested: { payload: "x".repeat(100) } }, 32)).toThrow(
      "sandbox worker request exceeds 32 MiB",
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertBoundedWorkerValue(cyclic, 1_000)).toThrow(
      "sandbox worker request is cyclic",
    );
    const shared = { value: 1 };
    expect(() => assertBoundedWorkerValue({ left: shared, right: shared }, 1_000)).not.toThrow();
  });
  test("happy path — sum of two numbers", async () => {
    const { output, stats } = await runJs<number>({
      code: "return input.a + input.b;",
      input: { a: 2, b: 3 },
      clock: null,
    });
    expect(output).toBe(5);
    expect(stats.ticks).toBeGreaterThan(0);
    expect(stats.worker_pid).toBeDefined();
    expect(stats.worker_pid).not.toBe(process.pid);
  });

  test("returns a structured object back to the host", async () => {
    const { output } = await runJs<{ doubled: number[]; sum: number }>({
      code: "const doubled = input.items.map(n => n * 2); return { doubled, sum: doubled.reduce((a, b) => a + b, 0) };",
      input: { items: [1, 2, 3, 4] },
      clock: null,
    });
    expect(output.doubled).toEqual([2, 4, 6, 8]);
    expect(output.sum).toBe(20);
  });

  test("memory cap denies a 200 MB allocation", async () => {
    let threw: unknown = null;
    try {
      await runJs({
        code: "const big = new Uint8Array(200 * 1024 * 1024); big[0] = 1; return big.length;",
        input: null,
        limits: { memory_bytes: 128 * 1024 * 1024, wall_ms: 5_000 },
        clock: null,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    expect(
      threw instanceof SandboxMemoryError ||
        threw instanceof SandboxInterruptError ||
        threw instanceof SandboxTimeoutError,
    ).toBe(true);
  });

  test("interrupt cap denies an infinite loop", async () => {
    let threw: unknown = null;
    try {
      await runJs({
        code: "let i = 0; while (true) { i += 1; }",
        input: null,
        limits: { tick_budget: 1_000_000, wall_ms: 3_000 },
        clock: null,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    expect(threw instanceof SandboxInterruptError || threw instanceof SandboxTimeoutError).toBe(
      true,
    );
  });

  test("wall timeout resets the worker and the next job is healthy", async () => {
    await expect(
      runJs({
        code: "while (true) {}",
        input: null,
        limits: { tick_budget: 1_000_000_000, wall_ms: 50 },
        clock: null,
      }),
    ).rejects.toBeInstanceOf(SandboxTimeoutError);
    const healthy = await runJs({ code: "return 'healthy';", input: null, clock: null });
    expect(healthy.output).toBe("healthy");
  });

  test("rotates tenants while jobs are waiting", async () => {
    const order: string[] = [];
    const run = (tenant_id: string, id: string, iterations = 100_000) =>
      withContext({ tenant_id }, async () => {
        const result = await runJs<string>({
          code: "let n = 0; for (let i = 0; i < input.iterations; i += 1) n += i; return input.id;",
          input: { id, iterations },
          clock: null,
        });
        order.push(result.output);
      });
    await Promise.all([run("a", "a1", 8_000_000), run("a", "a2"), run("a", "a3"), run("b", "b1")]);
    expect(order).toHaveLength(4);
    expect(order.indexOf("b1")).toBeLessThan(order.indexOf("a3"));
  });

  test("default jobs can occupy distinct isolated workers", async () => {
    const [first, second] = await Promise.all([
      runJs({ code: "return input.value;", input: { value: 1 }, clock: null }),
      runJs({ code: "return input.value;", input: { value: 2 }, clock: null }),
    ]);
    expect(first.stats.worker_pid).toBeDefined();
    expect(second.stats.worker_pid).toBeDefined();
    expect(first.stats.worker_pid).not.toBe(second.stats.worker_pid);
  });

  test("the tenant queue bound includes default and hook workers", async () => {
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const pending = withContext({ tenant_id: "shared-limit" }, async () => {
      const jobs = controllers.map((controller, index) =>
        runJs({
          code: "while (true) {}",
          input: null,
          clock: null,
          priority: index % 2 === 0 ? "default" : "hook",
          limits: { wall_ms: 100, tick_budget: 1_000_000_000 },
          signal: controller.signal,
        }).catch((error: unknown) => error),
      );
      const overflow = runJs({ code: "return 1;", input: null, clock: null });
      await expect(overflow).rejects.toThrow("sandbox worker queue is full");
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(jobs);
    });
    await pending;
  });

  test("host globals are not reachable from inside the VM", async () => {
    const { output } = await runJs<Record<string, string>>({
      code: `return {
        fetch: typeof fetch,
        process: typeof process,
        require: typeof require,
        Bun: typeof Bun,
        globalThis_fetch: typeof globalThis.fetch,
      };`,
      input: null,
      clock: null,
    });
    expect(output.fetch).toBe("undefined");
    expect(output.process).toBe("undefined");
    expect(output.require).toBe("undefined");
    expect(output.Bun).toBe("undefined");
    expect(output.globalThis_fetch).toBe("undefined");
  });

  test("rejects nondeterministic random and asynchronous results", async () => {
    await expect(
      runJs({ code: `return Math.${"random"}();`, input: null, clock: null }),
    ).rejects.toBeInstanceOf(SandboxRuntimeError);
    await expect(
      runJs({ code: "const r = Math['random']; return r();", input: null, clock: null }),
    ).rejects.toBeInstanceOf(SandboxRuntimeError);
    await expect(
      runJs({ code: "return Promise.resolve(42);", input: null, clock: null }),
    ).rejects.toBeInstanceOf(SandboxRuntimeError);
  });

  test("peak_memory_bytes is populated and bounded by the memory limit", async () => {
    const { stats } = await runJs<number>({
      code: "var bucket = []; for (var i = 0; i < 64; i++) { bucket.push(new Array(1024).join('x')); } return bucket.length;",
      input: null,
      limits: { memory_bytes: 32 * 1024 * 1024, wall_ms: 3_000 },
      clock: null,
    });
    expect(stats.peak_memory_bytes).not.toBeNull();
    expect(stats.peak_memory_bytes! > 0).toBe(true);
    expect(stats.peak_memory_bytes! <= 32 * 1024 * 1024).toBe(true);
  });
});
