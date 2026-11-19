import { terminalSize, useTheme } from "@chat-ui/index.ts";
import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";

export interface ResizeBoundaryProps {
  minCols?: number;
  minRows?: number;
  debounceMs?: number;
  children: React.ReactNode;
}

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
    sanitizeSize(
      { cols: terminalSize(stdout).columns, rows: terminalSize(stdout).rows },
      { cols: 80, rows: 24 },
    ),
  );

  useEffect(() => {
    if (!stdout) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const { columns, rows } = terminalSize(stdout);
        setSize(sanitizeSize({ cols: columns, rows }, { cols: 80, rows: 24 }));
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
