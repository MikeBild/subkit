// QuickJS WASM runtime for user-supplied JavaScript. Used by:
//   - `transform` steps with language: "javascript"
//   - before-request hook evaluator
//
// Guarantees:
//   - Zero host globals leaked into the VM (fetch, process, require, etc.
//     are undefined because QuickJS starts clean and we never install
//     them).
//   - Memory capped to `limits.memory_bytes` (default 128 MB) via
//     `runtime.setMemoryLimit`.
//   - A coarse `tick_budget` enforced via `setInterruptHandler`, which
//     QuickJS calls on an internal counter at loop back-edges and function
//     calls (NOT per opcode). We count those ticks and abort once the
//     budget is exhausted. This is a runaway backstop only — tight inner
//     loops can elide the handler, so the wall-clock cap below is the
//     primary guard.
//   - A wall-clock cap aborts long-running calls (the real limit for
//     compute-heavy code that evades the tick handler).
//
// The runtime returns `SandboxRunResult<T>` on success and throws a
// `SandboxError` subclass on every failure mode.

// Single-file variant: the WASM is inlined as base64 inside the JS, so
// it survives `bun build --compile` into the production binary. The
// default `getQuickJS()` loads the .wasm as a SEPARATE file, which is
// NOT embedded by --compile — the deployed binary then throws ENOENT on
// `emscripten-module.wasm` and every JS transform fails at runtime
// (invisible in `bun test`, which runs against node_modules; surfaced
// in prod once JS became the default authored transform language).
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

// Interrupt ticks between successive `computeMemoryUsage()` samples.
// Higher = cheaper overall cost; lower = more accurate peak. 512 keeps
// the sampling cost negligible (<1 % of tick budget) while still
// capturing spikes above 2k-tick budgets.
const MEMORY_SAMPLE_EVERY_TICKS = 512;

// Floor on the tick budget so even a tiny configured budget still lets
// trivial code finish a few interrupt boundaries before aborting.
const MIN_TICK_CAP = 2_000;

// Effective default limits: sourced from engine config (`sandbox.*`) when
// available, falling back to the static DEFAULT_LIMITS before
// `loadConfig()` has run (e.g. unit tests calling `runJs` directly). Per-
// call `opts.limits` still override these. Hooks keep their own tighter,
// security-fixed tiers in auth/hooks.ts and do not flow through here.
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

/**
 * Test override for the QuickJS WASM loader. Production code never
 * touches this — it exists only so the fail-closed regression test
 * can simulate "WASM module unavailable" and verify the sandbox
 * never falls back to a host `eval`.
 */
let _moduleProviderForTesting: (() => Promise<QuickJSWASMModule>) | null = null;

export function setQuickJsModuleProviderForTesting(
  provider: (() => Promise<QuickJSWASMModule>) | null,
): void {
  _moduleProviderForTesting = provider;
  if (provider) _mod = null;
}

/**
 * Lazy singleton — the WASM module costs ~a few hundred ms to instantiate
 * once and is then reusable across every VM we spawn. There is NO
 * host-eval fallback; if QuickJS fails to load, `runJs` throws
 * (fail-closed).
 */
async function loadModule(): Promise<QuickJSWASMModule> {
  if (_mod) return _mod;
  _mod = _moduleProviderForTesting
    ? await _moduleProviderForTesting()
    : await newQuickJSWASMModuleFromVariant(variant);
  return _mod;
}

export interface RunJsOptions {
  /** User-supplied source. Evaluated as a function body, not a module. */
  code: string;
  /** JSON-serializable value exposed as `input` to the user code. */
  input: unknown;
  /** Optional per-call limit overrides. */
  limits?: SandboxLimits;
}

/**
 * Execute user JavaScript under the configured limits and return the
 * value produced by the code (the last expression or an explicit
 * `return`). Host globals are NOT available — the VM starts clean.
 */
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

  // Safe wrapper around runtime.computeMemoryUsage(): returns null if
  // anything throws (sampling must never take down the host). On
  // success, extracts the `memory_used_size` field and records the
  // running peak.
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
    } catch {
      // Sampling is best-effort. If quickjs can't report memory here
      // (e.g. mid-abort), we just keep the previous peak value.
    }
  };

  // QuickJS fires the handler on an internal counter at loop back-edges
  // and function calls (not per opcode), so one tick covers an
  // unpredictable amount of work. We count ticks against `tick_budget`
  // (floored at MIN_TICK_CAP so a tiny budget still finishes trivial
  // code) as a coarse runaway backstop. The wall-clock check is the
  // primary guard; the periodic memory sample is piggy-backed here so we
  // do not need a separate timer.
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
    // Install the sk-Stdlib global (sk.http, sk.get, sk.allow, …)
    // before any user code runs. Failure here is an engine bug, not a
    // user error — surface it as a distinct sandbox kind so callers
    // can tell it apart from a user SyntaxError.
    const stdlibResult = context.evalCode(STDLIB_SOURCE, "sk-stdlib.js");
    if (stdlibResult.error) {
      const err = dumpError(context, stdlibResult.error);
      stdlibResult.error.dispose();
      throw new SandboxStdlibInitError(`sk-stdlib init failed: ${err.message}`, makeStats());
    }
    stdlibResult.value.dispose();

    // Marshal the input by JSON-encoding it on the host, shipping the
    // string into the VM, and parsing it there. This avoids building
    // arbitrarily-deep handle trees by hand.
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

    // Wrap user code as a function body so `return` works and so the
    // host can retrieve the result via a predictable global.
    const wrapped = `(() => { const input = globalThis.__sandbox_input__; const __fn__ = (function(input){\n${opts.code}\n}); const __out__ = __fn__(input); globalThis.__sandbox_output__ = __out__; return __out__; })()`;

    const evalResult = context.evalCode(wrapped, "sandbox.js");
    if (evalResult.error) {
      const err = dumpError(context, evalResult.error);
      evalResult.error.dispose();
      samplePeakMemory();
      // Distinguish syntax vs. runtime errors by name where possible.
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

    // Marshal the result back via JSON.stringify inside the VM to
    // guarantee it's a plain JSON value before it crosses the boundary.
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

    // Take the final peak sample while the VM is still alive and well-
    // behaved, so the returned stats reflect actual end-of-run memory.
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
    } catch {
      // already disposed
    }
    try {
      runtime.dispose();
    } catch {
      // already disposed
    }
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
