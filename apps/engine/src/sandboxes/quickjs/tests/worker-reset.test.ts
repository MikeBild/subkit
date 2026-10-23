import { describe, expect, test } from "bun:test";
import {
  prewarmSandboxWorkers,
  runJs,
  runSandboxWorkerJob,
  workerFailureResetReason,
} from "../runtime.ts";
import { SandboxRuntimeError, SandboxSyntaxError, SandboxTimeoutError } from "../types.ts";

async function hookPid(): Promise<number | undefined> {
  const result = await runJs<number>({
    code: "return 1;",
    input: null,
    clock: null,
    priority: "hook",
  });
  expect(result.output).toBe(1);
  return result.stats.worker_pid;
}

describe("sandbox worker reset semantics", () => {
  test("only infrastructure failure causes reset the worker", () => {
    expect(workerFailureResetReason({ cause_kind: "runtime" })).toBeNull();
    expect(workerFailureResetReason({ cause_kind: "syntax" })).toBeNull();
    expect(workerFailureResetReason({ cause_kind: "interrupt" })).toBeNull();
    expect(workerFailureResetReason(undefined)).toBeNull();
    expect(workerFailureResetReason({ cause_kind: "memory" })).toBe("memory");
    expect(workerFailureResetReason({ cause_kind: "timeout" })).toBe("timeout");
    expect(workerFailureResetReason({ cause_kind: "marshal" })).toBe("marshal");
    expect(workerFailureResetReason({ cause_kind: "stdlib_init" })).toBe("stdlib_init");
  });

  test("user code errors keep the worker alive", async () => {
    const before = await hookPid();
    expect(before).toBeDefined();
    await expect(
      runJs({
        code: "throw new Error('user failure');",
        input: null,
        clock: null,
        priority: "hook",
      }),
    ).rejects.toBeInstanceOf(SandboxRuntimeError);
    await expect(
      runJs({ code: "return (;", input: null, clock: null, priority: "hook" }),
    ).rejects.toBeInstanceOf(SandboxSyntaxError);
    await expect(
      runSandboxWorkerJob({
        op: "evaluate_jsonata",
        source: "$missing(",
        data: {},
        bindings: {},
        clock: null,
        wall_ms: 1_000,
        priority: "hook",
      }),
    ).rejects.toBeInstanceOf(SandboxRuntimeError);
    expect(await hookPid()).toBe(before);
  });

  test("a host deadline resets the worker and the cold start stays outside the next budget", async () => {
    const before = await hookPid();
    await expect(
      runSandboxWorkerJob({
        op: "evaluate_jsonata",
        source: "$sum([1..9999999].($ * 2))",
        data: {},
        bindings: {},
        clock: null,
        wall_ms: 50,
        priority: "hook",
      }),
    ).rejects.toBeInstanceOf(SandboxTimeoutError);
    const cold = await runJs<number>({
      code: "return 2;",
      input: null,
      clock: null,
      priority: "hook",
      limits: { wall_ms: 50 },
    });
    expect(cold.output).toBe(2);
    expect(cold.stats.worker_pid).toBeDefined();
    expect(cold.stats.worker_pid).not.toBe(before);
  });

  test("prewarm stays off unless configured", async () => {
    expect(await prewarmSandboxWorkers()).toBe(false);
  });
});
