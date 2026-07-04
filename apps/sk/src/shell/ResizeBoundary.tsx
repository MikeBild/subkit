// SIGWINCH-safe wrapper for the Ink tree.
//
// Ink renders to a buffer keyed by `process.stdout.columns/rows`. When
// the terminal is resized mid-render, the buffer can become stale —
// long lines wrap incorrectly and cursor placement drifts. Wrapping the
// app in this boundary forces a clean re-render on every resize, and
// renders a small fallback skeleton when the terminal is *known* too
// small for the chrome to fit.
//
// 80ms debounce avoids hammering the renderer during a continuous drag.
//
// Important: a stdout reporting 0 cols / 0 rows is treated as "no
// dimension info" rather than "tiny terminal" — that's what expect /
// script / non-resizing PTY emulators report, and rendering the
// fallback there hides Ink output the operator never gets to see.
// In that case we substitute conservative defaults (80×24).

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";

export interface ResizeBoundaryProps {
  /** Don't render children when stdout has fewer columns than this. */
  minCols?: number;
  /** Don't render children when stdout has fewer rows than this. */
  minRows?: number;
  /** Debounce window (ms). Defaults to 80. */
  debounceMs?: number;
  children: React.ReactNode;
}

/**
 * Sanitize a raw cols/rows pair from `process.stdout`. Zero / NaN /
 * undefined → treat as "no dimension info" and substitute the default
 * (caller's preference). Anything ≥ 1 is honored. The plot twist this
 * fixes: under expect(1) and script(1) PTY emulation the spawned
 * process gets `columns=0, rows=0` with no resize event ever firing,
 * and any ResizeBoundary render that triggers the "too small"
 * fallback in that state hides the Ink tree from any e2e harness.
 */
function sanitizeSize(
  raw: { cols?: number | undefined; rows?: number | undefined },
  fallback: { cols: number; rows: number },
): { cols: number; rows: number } {
  const c = typeof raw.cols === "number" && raw.cols > 0 ? raw.cols : fallback.cols;
  const r = typeof raw.rows === "number" && raw.rows > 0 ? raw.rows : fallback.rows;
  return { cols: c, rows: r };
}

export function ResizeBoundary({
  minCols = 40,
  minRows = 8,
  debounceMs = 80,
  children,
}: ResizeBoundaryProps): React.ReactElement {
  const { stdout } = useStdout();
  const [, bump] = useState(0);
  const [size, setSize] = useState(() =>
    sanitizeSize({ cols: stdout?.columns, rows: stdout?.rows }, { cols: 80, rows: 24 }),
  );

  useEffect(() => {
    if (!stdout) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setSize(sanitizeSize({ cols: stdout.columns, rows: stdout.rows }, { cols: 80, rows: 24 }));
        bump((n) => n + 1);
      }, debounceMs);
    };
    stdout.on("resize", onResize);
    return () => {
      if (timer) clearTimeout(timer);
      stdout.off("resize", onResize);
    };
  }, [stdout, debounceMs]);

  if (size.cols < minCols || size.rows < minRows) {
    return <ResizeFallback cols={size.cols} rows={size.rows} minCols={minCols} minRows={minRows} />;
  }

  // The state changes per-resize trigger a full re-render of children
  // even when their props are stable — that's the whole point.
  return <Box flexDirection="column">{children}</Box>;
}

export { sanitizeSize as _sanitizeSizeForTests };

function ResizeFallback({
  cols,
  rows,
  minCols,
  minRows,
}: {
  cols: number;
  rows: number;
  minCols: number;
  minRows: number;
}): React.ReactElement {
  const tokens = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={tokens.severity.warning}>terminal too small</Text>
      <Text color={tokens.severity.dim}>
        {cols}×{rows} ‹ {minCols}×{minRows}
      </Text>
      <Text color={tokens.severity.dim}>resize the window to continue</Text>
    </Box>
  );
}
