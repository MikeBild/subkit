import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { getConfig } from "../../config/loader.ts";
import { STDLIB_SOURCE } from "./stdlib/index.ts";
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
}

export async function runJs<T = unknown>(opts: RunJsOptions): Promise<SandboxRunResult<T>> {
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

    const wrapped = `(() => { const input = globalThis.__sandbox_input__; const __fn__ = (function(input){\n${opts.code}\n}); const __out__ = __fn__(input); globalThis.__sandbox_output__ = __out__; return __out__; })()`;

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
