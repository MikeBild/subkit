import { useEffect, useRef, useState } from "react";
import { buildStatusLine, type StatusLineConfig, type StatusLineInput } from "./render.ts";

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
