// SIGWINCH-safe wrapper for the Ink tree.
//
// Ink renders to a buffer keyed by `process.stdout.columns/rows`. When
// the terminal is resized mid-render, the buffer can become stale —
// long lines wrap incorrectly and cursor placement drifts. Wrapping the
// app in this boundary forces a clean re-render on every resize, and
// renders a small fallback skeleton when the terminal is too small for
// the chrome to fit.
//
// 80ms debounce avoids hammering the renderer during a continuous drag.

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

export function ResizeBoundary({
  minCols = 40,
  minRows = 8,
  debounceMs = 80,
  children,
}: ResizeBoundaryProps): React.ReactElement {
  const { stdout } = useStdout();
  const [, bump] = useState(0);
  const [size, setSize] = useState(() => ({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));

  useEffect(() => {
    if (!stdout) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
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
