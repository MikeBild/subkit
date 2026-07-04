// Keyboard-scrollable viewport for the transcript.
//
// The Ink runtime does not expose the terminal's native scrollback to
// React, so the usual strategy is to let the terminal scroll
// everything above the composer. That falls apart once Ink re-renders:
// the previous frame is erased and older content vanishes. We need an
// in-memory pager.
//
// ScrollView keeps the whole history in memory and displays a windowed
// slice. The window size is driven by the rendered `height` prop
// (rows), defaulting to the rest of the terminal minus a reserved
// composer/status band. Arrow keys / PgUp / PgDn / Home / End move the
// window; any new content auto-pins to the bottom unless the user has
// scrolled up. A windowed virtual-list approach simplified for the
// Ink 7 surface.

import { Box, Text, useInput, useStdout } from "ink";
import type React from "react";
import { Children, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useTheme } from "./theme/Provider.tsx";

export interface ScrollViewProps {
  /** Each child is one scrollable row; height is measured per-row. */
  children: React.ReactNode;
  /** Height in rows of the visible viewport. Defaults to `process.stdout.rows - reserved`. */
  height?: number;
  /** Rows reserved at the bottom for the composer + status. */
  reservedRows?: number;
  /** When true, the viewport is interactive and captures arrow keys. */
  active?: boolean;
  /** Show a "N above" hint when scrolled up. */
  showMoreHint?: boolean;
  /** Optional label announced to the user for accessibility / empty state. */
  emptyLabel?: string;
}

const DEFAULT_RESERVED_ROWS = 6; // spinner + status + composer + suggestion line

/**
 * A windowed, keyboard-scrollable container. Auto-pins to bottom on
 * new content; Home jumps to top; End jumps to bottom; PgUp/PgDn
 * move a viewport at a time; arrow keys move one row.
 */
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
    const rows = stdout?.rows ?? 24;
    return Math.max(3, rows - reservedRows);
  });

  // Measure the viewport on mount + whenever the terminal size changes.
  useLayoutEffect(() => {
    if (height && height > 0) {
      setViewportRows(height);
      return;
    }
    const recompute = (): void => {
      const rows = stdout?.rows ?? 24;
      setViewportRows(Math.max(3, rows - reservedRows));
    };
    recompute();
    if (!stdout) return;
    stdout.on("resize", recompute);
    return () => {
      stdout.off("resize", recompute);
    };
  }, [height, reservedRows, stdout]);

  // `offset` is the index of the *first visible row*. `length - offset`
  // rows are shown, up to viewportRows. When the user hasn't manually
  // scrolled, offset auto-follows the tail so new content stays pinned.
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
