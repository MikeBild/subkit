// Shared sandbox types for the QuickJS runtime.

export interface SandboxLimits {
  /** Hard WASM heap cap, in bytes. Default 128 MB. */
  memory_bytes?: number;
  /**
   * Interrupt-tick budget — a coarse runaway backstop, NOT an opcode
   * count. QuickJS fires the interrupt handler on an internal counter at
   * loop back-edges and function calls (not per opcode), so tight inner
   * loops can elide it entirely; the wall-clock and memory caps are the
   * real guards. Default 10_000_000.
   */
  tick_budget?: number;
  /** Wall-clock cap, the primary runaway guard. Default 30_000 ms. */
  wall_ms?: number;
  /** Max stack size, in bytes. Default 2 MB. */
  stack_bytes?: number;
}

export interface SandboxStats {
  /** Number of interrupt ticks consumed by the call (see tick_budget). */
  ticks: number;
  /** Wall-clock time spent inside the VM, in milliseconds. */
  duration_ms: number;
  /** Peak WASM memory reported by the runtime, in bytes, or null if unknown. */
  peak_memory_bytes: number | null;
}

export interface SandboxRunResult<T> {
  output: T;
  stats: SandboxStats;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    public readonly cause_kind:
      "memory" | "interrupt" | "timeout" | "syntax" | "runtime" | "marshal" | "stdlib_init",
    public readonly stats?: SandboxStats,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export class SandboxStdlibInitError extends SandboxError {
  constructor(message: string, stats?: SandboxStats) {
    super(message, "stdlib_init", stats);
    this.name = "SandboxStdlibInitError";
  }
}

export class SandboxMemoryError extends SandboxError {
  constructor(message = "sandbox memory cap reached", stats?: SandboxStats) {
    super(message, "memory", stats);
    this.name = "SandboxMemoryError";
  }
}

export class SandboxInterruptError extends SandboxError {
  constructor(message = "sandbox tick budget exhausted", stats?: SandboxStats) {
    super(message, "interrupt", stats);
    this.name = "SandboxInterruptError";
  }
}

export class SandboxTimeoutError extends SandboxError {
  constructor(message = "sandbox wall-clock budget exhausted", stats?: SandboxStats) {
    super(message, "timeout", stats);
    this.name = "SandboxTimeoutError";
  }
}

export class SandboxSyntaxError extends SandboxError {
  constructor(message: string, stats?: SandboxStats) {
    super(message, "syntax", stats);
    this.name = "SandboxSyntaxError";
  }
}

export class SandboxRuntimeError extends SandboxError {
  constructor(message: string, stats?: SandboxStats) {
    super(message, "runtime", stats);
    this.name = "SandboxRuntimeError";
  }
}

// Static fallback limits. The effective defaults are sourced from the
// engine config (`sandbox.*`) at call time; these values are the schema
// defaults and the fallback used before `loadConfig()` has run (e.g. unit
// tests that call `runJs` directly). See `resolveDefaultLimits` in runtime.ts.
export const DEFAULT_LIMITS: Required<SandboxLimits> = {
  memory_bytes: 128 * 1024 * 1024,
  tick_budget: 10_000_000,
  wall_ms: 30_000,
  stack_bytes: 2 * 1024 * 1024,
};
