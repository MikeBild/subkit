import { Box, Text, useInput, useStdout } from "ink";
import type React from "react";
import { Children, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { terminalSize } from "./platform.ts";
import { useTheme } from "./theme/Provider.tsx";

export interface ScrollViewProps {
  children: React.ReactNode;
  height?: number;
  reservedRows?: number;
  active?: boolean;
  showMoreHint?: boolean;
  emptyLabel?: string;
}

const DEFAULT_RESERVED_ROWS = 6;

export const ScrollView: React.FC<ScrollViewProps> = ({
  children,
  height,
  reservedRows = DEFAULT_RESERVED_ROWS,
  active = true,
  showMoreHint = true,
  emptyLabel,
}) => {
  const theme = useTheme();
  const childArray = useMemo(() => Children.toArray(children), [children]);
  const { stdout } = useStdout();

  const [viewportRows, setViewportRows] = useState<number>(() => {
    if (height && height > 0) return height;
    const rows = terminalSize(stdout).rows ?? 24;
    return Math.max(3, rows - reservedRows);
  });

  useLayoutEffect(() => {
    if (height && height > 0) {
      setViewportRows(height);
      return;
    }
    const recompute = (): void => {
      const rows = terminalSize(stdout).rows ?? 24;
      setViewportRows(Math.max(3, rows - reservedRows));
    };
    recompute();
    if (!stdout) return;
    stdout.on("resize", recompute);
    return () => {
      stdout.off("resize", recompute);
    };
  }, [height, reservedRows, stdout]);

  const [offset, setOffset] = useState(0);
  const [sticky, setSticky] = useState(true);

  useEffect(() => {
    if (!sticky) return;
    const next = Math.max(0, childArray.length - viewportRows);
    setOffset(next);
  }, [childArray.length, viewportRows, sticky]);

  const maxOffset = Math.max(0, childArray.length - viewportRows);
  const safeOffset = Math.min(offset, maxOffset);
  const visible = childArray.slice(safeOffset, safeOffset + viewportRows);
  const rowsAbove = safeOffset;
  const rowsBelow = Math.max(0, childArray.length - (safeOffset + visible.length));

  useInput(
    (_ch, key) => {
      const jump = Math.max(1, viewportRows - 1);
      if (key.pageUp || (key.ctrl && key.upArrow)) {
        setSticky(false);
        setOffset((o) => Math.max(0, o - jump));
        return;
      }
      if (key.pageDown || (key.ctrl && key.downArrow)) {
        setOffset((o) => Math.min(maxOffset, o + jump));
        setSticky(safeOffset + jump >= maxOffset);
        return;
      }
      if (key.upArrow && key.shift) {
        setSticky(false);
        setOffset((o) => Math.max(0, o - 1));
        return;
      }
      if (key.downArrow && key.shift) {
        setOffset((o) => Math.min(maxOffset, o + 1));
        setSticky(safeOffset + 1 >= maxOffset);
        return;
      }
      if (key.meta && key.upArrow) {
        setSticky(false);
        setOffset(0);
        return;
      }
      if (key.meta && key.downArrow) {
        setSticky(true);
        setOffset(maxOffset);
        return;
      }
    },
    { isActive: active },
  );

  if (childArray.length === 0) {
    return emptyLabel ? (
      <Box flexDirection="column">
        <Text color={theme.severity.dim}>{emptyLabel}</Text>
      </Box>
    ) : null;
  }

  return (
    <Box flexDirection="column">
      {showMoreHint && rowsAbove > 0 ? (
        <Text color={theme.severity.dim}>▲ {rowsAbove} more above (Shift+↑ / PgUp)</Text>
      ) : null}
      <Box flexDirection="column">
        {visible.map((node, i) => (
          <Box key={`sv-${safeOffset + i}`}>{node}</Box>
        ))}
      </Box>
      {showMoreHint && rowsBelow > 0 ? (
        <Text color={theme.severity.dim}>▼ {rowsBelow} more below (Shift+↓ / PgDn / End)</Text>
      ) : null}
    </Box>
  );
};
