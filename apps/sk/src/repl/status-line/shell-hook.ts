import { runStatusLineHook, type StatusLineInput } from "./render.ts";

export interface ShellHookOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ShellHookResult {
  line: string;
  source: "fresh" | "cached" | "aborted" | "error";
  error?: string;
}

interface CacheEntry {
  line: string;
  ts: number;
}

const cache = new Map<string, CacheEntry>();

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

export function _resetShellHookCacheForTests(): void {
  cache.clear();
}
