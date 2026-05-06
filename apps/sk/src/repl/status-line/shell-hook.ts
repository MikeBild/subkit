// Async-safe wrapper around the legacy shell-hook runner.
//
// Adds a tighter default timeout (800ms vs the legacy 2s — the REPL
// renders frequently enough that 2s is visible jank), AbortController
// support so React effects can cancel the hook on unmount, and a
// last-good cache so a slow hook never leaves the status line empty.

import { runStatusLineHook, type StatusLineInput } from "../../status-line.ts";

export interface ShellHookOptions {
  /** Hook timeout in ms. Default 800. */
  timeoutMs?: number;
  /** AbortSignal for cancellation (e.g. on unmount). */
  signal?: AbortSignal;
}

export interface ShellHookResult {
  /** Either the hook's stdout line, or the last-good cached value if the hook timed out. */
  line: string;
  /** Whether the result is fresh, cached, aborted, or failed. */
  source: "fresh" | "cached" | "aborted" | "error";
  /** Set when source is "error". */
  error?: string;
}

interface CacheEntry {
  line: string;
  ts: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Run the hook, with abort + timeout + last-good fallback.
 * Always resolves; never throws.
 */
export async function runShellHook(
  command: string,
  input: StatusLineInput,
  opts: ShellHookOptions = {},
): Promise<ShellHookResult> {
  const timeoutMs = opts.timeoutMs ?? 800;
  const signal = opts.signal;

  if (signal?.aborted) {
    const cached = cache.get(command);
    return cached ? { line: cached.line, source: "cached" } : { line: "", source: "aborted" };
  }

  // Race the hook against an abort + an internal timeout. The legacy
  // runner already kills the child on its own timeout; we just need a
  // shorter outer one to honor the REPL's faster render cadence.
  const result = await new Promise<ShellHookResult>((resolve) => {
    let resolved = false;
    const finish = (r: ShellHookResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      const cached = cache.get(command);
      finish(
        cached
          ? { line: cached.line, source: "cached" }
          : { line: "", source: "error", error: `timed out after ${timeoutMs}ms` },
      );
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      const cached = cache.get(command);
      finish(cached ? { line: cached.line, source: "cached" } : { line: "", source: "aborted" });
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    runStatusLineHook(command, input, timeoutMs).then(
      (line) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        cache.set(command, { line, ts: Date.now() });
        finish({ line, source: "fresh" });
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const cached = cache.get(command);
        const errorMsg = err instanceof Error ? err.message : String(err);
        finish(
          cached
            ? { line: cached.line, source: "cached" }
            : { line: "", source: "error", error: errorMsg },
        );
      },
    );
  });

  return result;
}

/** Test-only: drop the in-memory last-good cache. */
export function _resetShellHookCacheForTests(): void {
  cache.clear();
}
