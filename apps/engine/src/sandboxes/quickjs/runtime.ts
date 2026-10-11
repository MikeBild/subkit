import { availableParallelism } from "node:os";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { getConfig } from "../../config/loader.ts";
import { getContext } from "../../logging/context.ts";
import { STDLIB_HELPER_SOURCES, STDLIB_SOURCE } from "./stdlib/index.ts";
import {
  DEFAULT_LIMITS,
  SandboxError,
  SandboxInterruptError,
  type SandboxLimits,
  SandboxMemoryError,
  type SandboxRunResult,
  SandboxRuntimeError,
  type SandboxStats,
  SandboxStdlibInitError,
  SandboxSyntaxError,
  SandboxTimeoutError,
} from "./types.ts";

const MEMORY_SAMPLE_EVERY_TICKS = 512;

const MIN_TICK_CAP = 2_000;

function resolveDefaultLimits(): Required<SandboxLimits> {
  try {
    const s = getConfig().sandbox;
    return {
      memory_bytes: s.memory_bytes,
      tick_budget: s.tick_budget,
      wall_ms: s.wall_ms,
      stack_bytes: s.stack_bytes,
    };
  } catch {
    return DEFAULT_LIMITS;
  }
}

let _mod: QuickJSWASMModule | null = null;

let _moduleProviderForTesting: (() => Promise<QuickJSWASMModule>) | null = null;

export function setQuickJsModuleProviderForTesting(
  provider: (() => Promise<QuickJSWASMModule>) | null,
): void {
  _moduleProviderForTesting = provider;
  if (provider) _mod = null;
}

async function loadModule(): Promise<QuickJSWASMModule> {
  if (_mod) return _mod;
  _mod = _moduleProviderForTesting
    ? await _moduleProviderForTesting()
    : await newQuickJSWASMModuleFromVariant(variant);
  return _mod;
}

export interface RunJsOptions {
  code: string;
  input: unknown;
  limits?: SandboxLimits;
  clock: {
    now_ms: number;
    seed: string;
  } | null;
  priority?: "default" | "hook";
  signal?: AbortSignal;
}

export async function runJs<T = unknown>(opts: RunJsOptions): Promise<SandboxRunResult<T>> {
  if (process.argv.includes("--sandbox-worker") || _moduleProviderForTesting) {
    return runJsInCurrentProcess(opts);
  }
  return runJsInWorker(opts);
}

export async function runJsInCurrentProcess<T = unknown>(
  opts: RunJsOptions,
): Promise<SandboxRunResult<T>> {
  if (/\bMath\s*\.\s*random\s*\(/.test(opts.code)) {
    throw new SandboxRuntimeError(
      "Math.random() is not available in deterministic sandbox execution",
    );
  }
  const limits = { ...resolveDefaultLimits(), ...opts.limits };
  const mod = await loadModule();

  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(limits.memory_bytes);
  runtime.setMaxStackSize(limits.stack_bytes);

  const context = runtime.newContext();
  const started = Date.now();
  const deadline = started + limits.wall_ms;

  let ticks = 0;
  let interrupted = false;
  let timedOut = false;
  let peakMemory = 0;

  const samplePeakMemory = (): void => {
    try {
      const handle = runtime.computeMemoryUsage();
      try {
        const dumped = context.dump(handle) as Record<string, number> | null;
        if (dumped && typeof dumped.memory_used_size === "number") {
          if (dumped.memory_used_size > peakMemory) {
            peakMemory = dumped.memory_used_size;
          }
        }
      } finally {
        handle.dispose();
      }
    } catch {}
  };

  const tick_cap = Math.max(MIN_TICK_CAP, limits.tick_budget);
  runtime.setInterruptHandler(() => {
    ticks += 1;
    if (ticks % MEMORY_SAMPLE_EVERY_TICKS === 0) {
      samplePeakMemory();
    }
    if (ticks >= tick_cap) {
      interrupted = true;
      return true;
    }
    if (Date.now() > deadline) {
      interrupted = true;
      timedOut = true;
      return true;
    }
    return false;
  });

  const makeStats = (): SandboxStats => ({
    ticks,
    duration_ms: Date.now() - started,
    peak_memory_bytes: peakMemory > 0 ? peakMemory : null,
  });

  try {
    const nowMs = opts.clock?.now_ms ?? 0;
    const seed = opts.clock?.seed ?? "";
    const nowHandle = context.newNumber(Number.isFinite(nowMs) ? nowMs : 0);
    context.setProp(context.global, "__sandbox_now__", nowHandle);
    nowHandle.dispose();
    const seedHandle = context.newString(seed);
    context.setProp(context.global, "__sandbox_seed__", seedHandle);
    seedHandle.dispose();
    const helperHandle = context.newFunction("__sk_helper_source__", (nameHandle) => {
      const name = context.getString(nameHandle);
      const source = STDLIB_HELPER_SOURCES[name];
      if (source === undefined) throw new Error("unknown sandbox helper");
      return context.newString(source);
    });
    context.setProp(context.global, "__sk_helper_source__", helperHandle);
    helperHandle.dispose();

    const stdlibResult = context.evalCode(STDLIB_SOURCE, "sk-stdlib.js");
    if (stdlibResult.error) {
      const err = dumpError(context, stdlibResult.error);
      stdlibResult.error.dispose();
      throw new SandboxStdlibInitError(`sk-stdlib init failed: ${err.message}`, makeStats());
    }
    stdlibResult.value.dispose();

    if (opts.clock) {
      const dateResult = context.evalCode(
        `(() => {
        const NativeDate = Date;
        const instant = sk.now();
        function FixedDate(...args) {
          if (!new.target) return new NativeDate(instant).toString();
          return Reflect.construct(NativeDate, args.length ? args : [instant], new.target);
        }
        Object.setPrototypeOf(FixedDate, NativeDate);
        FixedDate.prototype = NativeDate.prototype;
        Object.defineProperty(FixedDate, "now", { value: () => instant });
        globalThis.Date = FixedDate;
      })()`,
        "execution-clock.js",
      );
      if (dateResult.error) {
        const err = dumpError(context, dateResult.error);
        dateResult.error.dispose();
        throw new SandboxStdlibInitError(
          `execution clock init failed: ${err.message}`,
          makeStats(),
        );
      }
      dateResult.value.dispose();
    }

    const randomResult = context.evalCode(
      `Object.defineProperty(Math, "random", { value: () => { throw new TypeError("Math.random() is not available in deterministic sandbox execution"); }, writable: false, configurable: false });`,
      "determinism.js",
    );
    if (randomResult.error) {
      const err = dumpError(context, randomResult.error);
      randomResult.error.dispose();
      throw new SandboxStdlibInitError(`determinism init failed: ${err.message}`, makeStats());
    }
    randomResult.value.dispose();

    const inputJson = JSON.stringify(opts.input ?? null);
    const inputStr = context.newString(inputJson);
    const jsonObj = context.getProp(context.global, "JSON");
    const parseFn = context.getProp(jsonObj, "parse");
    const inputHandle = context.unwrapResult(context.callFunction(parseFn, jsonObj, inputStr));
    context.setProp(context.global, "__sandbox_input__", inputHandle);
    inputStr.dispose();
    inputHandle.dispose();
    parseFn.dispose();
    jsonObj.dispose();

    const wrapped = `(() => { const input = globalThis.__sandbox_input__; const __fn__ = (function(input){\n${opts.code}\n}); const __out__ = __fn__(input); if (__out__ && (typeof __out__ === "object" || typeof __out__ === "function") && typeof __out__.then === "function") throw new TypeError("sandbox code must return a JSON value, not a Promise or thenable"); globalThis.__sandbox_output__ = __out__; return __out__; })()`;

    const evalResult = context.evalCode(wrapped, "sandbox.js");
    if (evalResult.error) {
      const err = dumpError(context, evalResult.error);
      evalResult.error.dispose();
      samplePeakMemory();
      if (timedOut) {
        throw new SandboxTimeoutError("sandbox exceeded wall-clock budget", makeStats());
      }
      if (interrupted) {
        throw new SandboxInterruptError("sandbox interrupted", makeStats());
      }
      if (Date.now() > deadline) {
        throw new SandboxTimeoutError("sandbox exceeded wall-clock budget", makeStats());
      }
      if (/memory/i.test(err.message) || /out of memory/i.test(err.message)) {
        throw new SandboxMemoryError(err.message, makeStats());
      }
      if (err.name === "SyntaxError") {
        throw new SandboxSyntaxError(err.message, makeStats());
      }
      throw new SandboxRuntimeError(err.message, makeStats());
    }

    const resultHandle = evalResult.value;
    const jsonObj2 = context.getProp(context.global, "JSON");
    const stringifyFn = context.getProp(jsonObj2, "stringify");
    const stringified = context.unwrapResult(
      context.callFunction(stringifyFn, jsonObj2, resultHandle),
    );
    let outputJson: string | undefined;
    if (context.typeof(stringified) === "string") {
      outputJson = context.getString(stringified);
    }
    stringified.dispose();
    stringifyFn.dispose();
    jsonObj2.dispose();
    resultHandle.dispose();

    samplePeakMemory();
    const stats = makeStats();
    let parsed: unknown;
    if (outputJson !== undefined) {
      try {
        parsed = JSON.parse(outputJson);
      } catch (err) {
        throw new SandboxError(
          `failed to marshal sandbox output: ${(err as Error).message}`,
          "marshal",
          stats,
        );
      }
    }
    return { output: parsed as T, stats };
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    samplePeakMemory();
    const stats = makeStats();
    if (interrupted) {
      throw new SandboxInterruptError(message, stats);
    }
    if (/memory/i.test(message) || /out of memory/i.test(message)) {
      throw new SandboxMemoryError(message, stats);
    }
    throw new SandboxRuntimeError(message, stats);
  } finally {
    try {
      context.dispose();
    } catch {}
    try {
      runtime.dispose();
    } catch {}
  }
}

interface WorkerFailure {
  name: string;
  message: string;
  cause_kind?: SandboxError["cause_kind"];
  stats?: SandboxStats;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: WorkerFailure;
}

const MAX_WORKER_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_BINARY_WORKER_WIRE_BYTES = 45 * 1024 * 1024;

function workerLimits(): {
  queue_limit: number;
  tenant_queue_limit: number;
  ipc_max_bytes: number;
  worker_rss_bytes: number;
} {
  try {
    const sandbox = getConfig().sandbox;
    return {
      queue_limit: sandbox.queue_limit,
      tenant_queue_limit: sandbox.tenant_queue_limit,
      ipc_max_bytes: Math.min(sandbox.ipc_max_bytes, MAX_WORKER_MESSAGE_BYTES),
      worker_rss_bytes: sandbox.worker_rss_bytes,
    };
  } catch {
    return {
      queue_limit: 32,
      tenant_queue_limit: 8,
      ipc_max_bytes: MAX_WORKER_MESSAGE_BYTES,
      worker_rss_bytes: 512 * 1024 * 1024,
    };
  }
}

async function runJsInWorker<T>(opts: RunJsOptions): Promise<SandboxRunResult<T>> {
  const normalized: RunJsOptions = {
    ...opts,
    limits: { ...resolveDefaultLimits(), ...opts.limits },
  };
  const lane = normalized.priority === "hook" ? hookLane : defaultPool;
  return lane.run<SandboxRunResult<T>>(
    { op: "run_js", opts: serializableRunOptions(normalized) },
    normalized,
  );
}

export type SandboxWorkerJob =
  | {
      op: "evaluate_jsonata";
      source: string;
      data: unknown;
      bindings: Record<string, unknown>;
      clock: { now_ms: number; seed?: string } | null;
      wall_ms: number;
      priority?: "default" | "hook";
      signal?: AbortSignal;
    }
  | {
      op: "parse_binary";
      format: "pdf" | "docx" | "xlsx" | "xls" | "pptx" | "zip" | "gzip";
      buffer: string;
      wall_ms: number;
      priority?: "default" | "hook";
      signal?: AbortSignal;
    };

export async function runSandboxWorkerJob<T>(request: SandboxWorkerJob): Promise<T> {
  const lane = request.priority === "hook" ? hookLane : defaultPool;
  const { wall_ms, priority: _priority, signal, ...body } = request;
  return lane.run<T>(body, {
    limits: { wall_ms },
    ...(signal ? { signal } : {}),
    ...(request.priority ? { priority: request.priority } : {}),
  });
}

function serializableRunOptions(opts: RunJsOptions): Omit<RunJsOptions, "signal"> {
  const { signal: _signal, ...body } = opts;
  return body;
}

export function assertBoundedWorkerValue(value: unknown, maxBytes: number): void {
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const active = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  const measureString = (input: string): number => {
    let size = Buffer.byteLength(input) + 2;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (
        code === 34 ||
        code === 92 ||
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      )
        size += 1;
      else if (code < 32) size += 5;
    }
    return size;
  };
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    if (next.exit) {
      active.delete(next.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > 1_000_000 || next.depth > 512) {
      throw new SandboxError("sandbox worker request is too complex", "marshal");
    }
    const current = next.value;
    if (typeof current === "string") bytes += measureString(current);
    else if (typeof current === "number" || typeof current === "boolean")
      bytes += String(current).length;
    else if (current === null || current === undefined) bytes += 4;
    else if (typeof current === "object") {
      if (active.has(current))
        throw new SandboxError("sandbox worker request is cyclic", "marshal");
      active.add(current);
      stack.push({ value: current, depth: next.depth, exit: true });
      if (Array.isArray(current)) {
        bytes += current.length + 1;
        for (const entry of current) stack.push({ value: entry, depth: next.depth + 1 });
      } else {
        const entries = Object.entries(current);
        bytes += entries.length + 1;
        for (const [key, entry] of entries) {
          bytes += measureString(key) + 1;
          stack.push({ value: entry, depth: next.depth + 1 });
        }
      }
    } else throw new SandboxError("sandbox worker request is not JSON-compatible", "marshal");
    if (bytes > maxBytes)
      throw new SandboxError("sandbox worker request exceeds 32 MiB", "marshal");
  }
}

interface WorkerJob<T> {
  tenant: string;
  request: Record<string, unknown>;
  opts: Pick<RunJsOptions, "limits" | "signal" | "priority">;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  abort?: () => void;
}

const workerAdmission = {
  queued: 0,
  perTenant: new Map<string, number>(),
  admit(tenant: string): void {
    const limits = workerLimits();
    if (
      this.queued >= limits.queue_limit ||
      (this.perTenant.get(tenant) ?? 0) >= limits.tenant_queue_limit
    ) {
      throw new SandboxRuntimeError("sandbox worker queue is full");
    }
    this.queued += 1;
    this.perTenant.set(tenant, (this.perTenant.get(tenant) ?? 0) + 1);
  },
  complete(tenant: string): void {
    this.queued -= 1;
    const remaining = (this.perTenant.get(tenant) ?? 1) - 1;
    if (remaining === 0) this.perTenant.delete(tenant);
    else this.perTenant.set(tenant, remaining);
  },
};

class WorkerLane {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private pending: {
    id: number;
    resolve: (response: WorkerResponse) => void;
    reject: (reason: unknown) => void;
  } | null = null;
  private queued = 0;
  private readonly perTenant = new Map<string, number>();
  private readonly queues = new Map<string, WorkerJob<unknown>[]>();
  private readonly tenantOrder: string[] = [];
  private running = false;
  private generation = 0;

  get load(): number {
    return this.queued;
  }

  run<T>(
    request: Record<string, unknown>,
    opts: Pick<RunJsOptions, "limits" | "signal" | "priority">,
  ): Promise<T> {
    const tenant = getContext().tenant_id ?? "system";
    if (opts.signal?.aborted)
      return Promise.reject(new SandboxTimeoutError("sandbox worker aborted"));
    workerAdmission.admit(tenant);
    return new Promise<T>((resolve, reject) => {
      const job: WorkerJob<T> = { tenant, request, opts, resolve, reject };
      const abort = () => this.cancel(job as WorkerJob<unknown>);
      if (opts.signal) job.abort = abort;
      this.queued += 1;
      this.perTenant.set(tenant, (this.perTenant.get(tenant) ?? 0) + 1);
      const queue = this.queues.get(tenant);
      if (queue) queue.push(job as WorkerJob<unknown>);
      else {
        this.queues.set(tenant, [job as WorkerJob<unknown>]);
        this.tenantOrder.push(tenant);
      }
      opts.signal?.addEventListener("abort", abort, { once: true });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const job = this.next();
        if (!job) return;
        try {
          job.resolve(await this.execute(job.request, job.opts));
        } catch (err) {
          job.reject(err);
        } finally {
          if (job.abort) job.opts.signal?.removeEventListener("abort", job.abort);
          this.complete(job.tenant);
        }
      }
    } finally {
      this.running = false;
      if (this.queued > 0) void this.drain();
    }
  }

  private next(): WorkerJob<unknown> | null {
    const tenant = this.tenantOrder.shift();
    if (!tenant) return null;
    const queue = this.queues.get(tenant);
    const job = queue?.shift() ?? null;
    if (queue && queue.length > 0) this.tenantOrder.push(tenant);
    else this.queues.delete(tenant);
    return job;
  }

  private cancel(job: WorkerJob<unknown>): void {
    const queue = this.queues.get(job.tenant);
    if (!queue) return;
    const index = queue.indexOf(job);
    if (index < 0) return;
    queue.splice(index, 1);
    if (queue.length === 0) {
      this.queues.delete(job.tenant);
      const orderIndex = this.tenantOrder.indexOf(job.tenant);
      if (orderIndex >= 0) this.tenantOrder.splice(orderIndex, 1);
    }
    this.complete(job.tenant);
    job.reject(new SandboxTimeoutError("sandbox worker aborted"));
  }

  private complete(tenant: string): void {
    this.queued -= 1;
    workerAdmission.complete(tenant);
    const remaining = (this.perTenant.get(tenant) ?? 1) - 1;
    if (remaining === 0) this.perTenant.delete(tenant);
    else this.perTenant.set(tenant, remaining);
  }

  private async execute<T>(
    body: Record<string, unknown>,
    opts: Pick<RunJsOptions, "limits" | "signal">,
  ): Promise<T> {
    const workerConfig = workerLimits();
    if (
      body.op === "parse_binary" &&
      typeof body.buffer === "string" &&
      Buffer.byteLength(body.buffer, "base64") > workerConfig.ipc_max_bytes
    ) {
      throw new SandboxError("parser input exceeds decoded worker transport limit", "marshal");
    }
    const requestLimit =
      body.op === "parse_binary" ? MAX_BINARY_WORKER_WIRE_BYTES : workerConfig.ipc_max_bytes;
    assertBoundedWorkerValue(body, requestLimit);
    const request = JSON.stringify(body);
    if (Buffer.byteLength(request) > requestLimit) {
      throw new SandboxError("sandbox worker request exceeds 32 MiB", "marshal");
    }
    if (opts.signal?.aborted) throw new SandboxTimeoutError("sandbox worker aborted");
    const script = new URL("../../index.ts", import.meta.url).pathname;
    const child = this.ensure(script);
    const generation = ++this.generation;
    const abort = () => child.kill();
    let rssExceeded = false;
    let deadlineExceeded = false;
    const rssTimer = setInterval(() => {
      void this.exceedsRss(child.pid, workerConfig.worker_rss_bytes).then((exceeded) => {
        if (!exceeded || this.generation !== generation || this.child !== child) return;
        rssExceeded = true;
        child.kill();
      });
    }, 50);
    rssTimer.unref?.();
    opts.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => {
        deadlineExceeded = true;
        abort();
      },
      (opts.limits?.wall_ms ?? resolveDefaultLimits().wall_ms) + 250,
    );
    timeout.unref?.();
    try {
      const response = await new Promise<WorkerResponse>((resolve, reject) => {
        this.pending = { id: generation, resolve, reject };
        child.send({ id: generation, body });
      });
      if (Buffer.byteLength(JSON.stringify(response)) > workerConfig.ipc_max_bytes) {
        throw new SandboxError("sandbox worker response exceeds 32 MiB", "marshal");
      }
      if (response.ok) {
        await this.recycleForRss(workerConfig.worker_rss_bytes);
        return this.withWorkerPid(response.result, child.pid) as T;
      }
      throw workerError(response.error);
    } catch (err) {
      this.reset();
      if (rssExceeded) throw new SandboxMemoryError("sandbox worker RSS threshold exceeded");
      if (deadlineExceeded)
        throw new SandboxTimeoutError("sandbox worker exceeded wall-clock budget");
      if (err instanceof SandboxError) throw err;
      if (opts.signal?.aborted) throw new SandboxTimeoutError("sandbox worker aborted");
      throw new SandboxRuntimeError(
        `sandbox worker failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
      clearInterval(rssTimer);
      opts.signal?.removeEventListener("abort", abort);
    }
  }

  private ensure(script: string): ReturnType<typeof Bun.spawn> {
    if (this.child) return this.child;
    const compiled = process.execPath.includes("/$bunfs/") || !process.execPath.includes("bun");
    const args = compiled ? ["--sandbox-worker"] : ["--no-env-file", script, "--sandbox-worker"];
    this.child = Bun.spawn([process.execPath, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "production" },
      ipc: (message, source) => {
        const response = message as WorkerResponse;
        const pending = this.pending;
        if (!pending || source !== this.child) return;
        if (response?.id !== pending.id) {
          this.pending = null;
          pending.reject(new Error("sandbox worker returned an invalid response"));
          return;
        }
        this.pending = null;
        pending.resolve(response);
      },
    });
    const child = this.child;
    void child.exited.then(() => {
      if (this.child !== child) return;
      this.pending?.reject(new Error("sandbox worker exited without a response"));
      this.pending = null;
      this.child = null;
    });
    return this.child;
  }

  close(): void {
    for (const queue of this.queues.values()) {
      for (const job of queue) {
        if (job.abort) job.opts.signal?.removeEventListener("abort", job.abort);
        this.complete(job.tenant);
        job.reject(new SandboxTimeoutError("sandbox worker pool closed"));
      }
    }
    this.queues.clear();
    this.tenantOrder.length = 0;
    this.reset();
  }

  private reset(): void {
    this.generation += 1;
    this.pending?.reject(new Error("sandbox worker reset"));
    this.pending = null;
    this.child?.kill();
    this.child = null;
  }

  private async recycleForRss(limit: number): Promise<void> {
    if (!this.child || !(await this.exceedsRss(this.child.pid, limit))) return;
    this.reset();
  }

  private withWorkerPid(result: unknown, pid: number): unknown {
    if (!result || typeof result !== "object" || !("stats" in result)) return result;
    const run = result as { output?: unknown; stats?: SandboxStats };
    if (!run.stats) return result;
    return { ...run, stats: { ...run.stats, worker_pid: pid } };
  }

  private async exceedsRss(pid: number, limit: number): Promise<boolean> {
    if (process.platform !== "linux") return false;
    try {
      const status = await Bun.file(`/proc/${pid}/status`).text();
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      return Boolean(match && Number(match[1]) * 1024 > limit);
    } catch {
      return false;
    }
  }
}

class WorkerPool {
  private readonly lanes: WorkerLane[];
  private nextLane = 0;

  constructor(size: number) {
    this.lanes = Array.from({ length: size }, () => new WorkerLane());
  }

  run<T>(
    request: Record<string, unknown>,
    opts: Pick<RunJsOptions, "limits" | "signal" | "priority">,
  ): Promise<T> {
    let selected = this.nextLane;
    for (let index = 0; index < this.lanes.length; index += 1) {
      if ((this.lanes[index]?.load ?? Infinity) < (this.lanes[selected]?.load ?? Infinity)) {
        selected = index;
      }
    }
    this.nextLane = (selected + 1) % this.lanes.length;
    const result = this.lanes[selected]?.run<T>(request, opts);
    if (!result) throw new SandboxRuntimeError("sandbox worker pool is unavailable");
    return result;
  }

  close(): void {
    for (const lane of this.lanes) lane.close();
  }
}

const defaultPool = new WorkerPool(Math.min(2, availableParallelism()));
const hookLane = new WorkerLane();

export function closeSandboxWorkers(): void {
  defaultPool.close();
  hookLane.close();
}

process.once("exit", closeSandboxWorkers);

function workerError(error: WorkerFailure | undefined): SandboxError {
  const message = error?.message ?? "sandbox worker returned no result";
  switch (error?.cause_kind) {
    case "memory":
      return new SandboxMemoryError(message, error.stats);
    case "interrupt":
      return new SandboxInterruptError(message, error.stats);
    case "timeout":
      return new SandboxTimeoutError(message, error.stats);
    case "syntax":
      return new SandboxSyntaxError(message, error.stats);
    case "stdlib_init":
      return new SandboxStdlibInitError(message, error.stats);
    case "marshal":
      return new SandboxError(message, "marshal", error.stats);
    default:
      return new SandboxRuntimeError(message, error?.stats);
  }
}

interface DumpedError {
  name: string;
  message: string;
  stack: string | null;
}

function dumpError(
  context: ReturnType<QuickJSWASMModule["newContext"]>,
  handle: QuickJSHandle,
): DumpedError {
  try {
    const nameHandle = context.getProp(handle, "name");
    const messageHandle = context.getProp(handle, "message");
    const stackHandle = context.getProp(handle, "stack");
    const name = context.typeof(nameHandle) === "string" ? context.getString(nameHandle) : "Error";
    const message =
      context.typeof(messageHandle) === "string" ? context.getString(messageHandle) : "error";
    const stack = context.typeof(stackHandle) === "string" ? context.getString(stackHandle) : null;
    nameHandle.dispose();
    messageHandle.dispose();
    stackHandle.dispose();
    return { name, message, stack };
  } catch {
    return { name: "Error", message: "sandbox error", stack: null };
  }
}
