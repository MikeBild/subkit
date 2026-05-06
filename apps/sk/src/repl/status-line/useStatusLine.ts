// React hook that drives the status line's async refresh loop.
//
// The hook never blocks the render loop:
//   - shell hooks run via runShellHook (AbortController + timeoutMs)
//   - the abort fires on unmount, so a stuck hook can't leak children
//   - a last-good cache means stuck hooks fall back to the previous
//     frame instead of going blank
//
// `refreshMs` controls how often the hook re-runs. Defaults to 500ms,
// matching the legacy behavior; the existing config can override it.

import { useEffect, useRef, useState } from "react";
import { buildStatusLine, type StatusLineConfig, type StatusLineInput } from "../../status-line.ts";

export interface UseStatusLineResult {
  line: string;
  source: "hook" | "template" | "fallback" | "loading";
  error?: string;
}

export function useStatusLine(
  config: StatusLineConfig | undefined,
  input: StatusLineInput,
  refreshMs = 500,
): UseStatusLineResult {
  const [result, setResult] = useState<UseStatusLineResult>({ line: "", source: "loading" });
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    const controller = new AbortController();
    let interval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (controller.signal.aborted || cancelled) return;
      try {
        const r = await buildStatusLine(config, inputRef.current);
        if (!controller.signal.aborted && !cancelled) {
          setResult(
            r.error
              ? { line: r.line, source: r.source, error: r.error }
              : { line: r.line, source: r.source },
          );
        }
      } catch (err) {
        if (cancelled) return;
        setResult({
          line: "",
          source: "fallback",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    void tick();
    interval = setInterval(tick, refreshMs);
    return () => {
      cancelled = true;
      controller.abort();
      if (interval) clearInterval(interval);
    };
  }, [config?.command, config?.format, config?.refreshMs, refreshMs]);

  return result;
}
