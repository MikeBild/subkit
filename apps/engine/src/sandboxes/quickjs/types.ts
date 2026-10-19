export interface SandboxLimits {
  memory_bytes?: number;
  tick_budget?: number;
  wall_ms?: number;
  stack_bytes?: number;
}

export interface SandboxStats {
  ticks: number;
  duration_ms: number;
  peak_memory_bytes: number | null;
  worker_pid?: number;
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

export function sandboxFailureCode(error: unknown): string | null {
  return error instanceof SandboxError ? `sandbox_${error.cause_kind}` : null;
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

export const DEFAULT_LIMITS: Required<SandboxLimits> = {
  memory_bytes: 128 * 1024 * 1024,
  tick_budget: 10_000_000,
  wall_ms: 30_000,
  stack_bytes: 2 * 1024 * 1024,
};
