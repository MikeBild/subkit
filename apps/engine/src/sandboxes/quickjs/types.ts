// Shared sandbox types for the QuickJS runtime.

export interface SandboxLimits {
  /** Hard WASM heap cap, in bytes. Default 128 MB. */
  memory_bytes?: number;
  /** Interrupt budget as a rough opcode count. Default 10_000_000. */
  opcode_budget?: number;
  /** Wall-clock cap as a safety net. Default 30_000 ms. */
  wall_ms?: number;
  /** Max stack size, in bytes. Default 1 MB. */
  stack_bytes?: number;
}

export interface SandboxStats {
  /** Number of interrupt ticks consumed by the call. */
  opcode_ticks: number;
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
      | "memory"
      | "interrupt"
      | "timeout"
      | "syntax"
      | "runtime"
      | "marshal"
      | "stdlib_init",
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
  constructor(message = "sandbox opcode budget exhausted", stats?: SandboxStats) {
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

export const DEFAULT_LIMITS: Required<SandboxLimits> = {
  memory_bytes: 128 * 1024 * 1024,
  opcode_budget: 10_000_000,
  wall_ms: 30_000,
  stack_bytes: 1 * 1024 * 1024,
};
