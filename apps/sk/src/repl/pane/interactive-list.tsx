// Interactive list pane — Codex-style scrollable list with arrow-key
// navigation and per-row inline actions. Generic over the row type;
// callers supply a label-rendering function plus a key-action handler
// keyed on the highlighted row.
//
// The pane owns its `useInput` listener while mounted, so the ink-app
// host must yield the keyboard to it (the existing one-active-useInput
// discipline applies — see `apps/sk/src/ink-app.tsx` notes on
// `MultiChoicePrompt` for the analog).

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import { useCallback, useState } from "react";

export interface InteractiveListProps<Row> {
  rows: ReadonlyArray<Row>;
  /** Per-row label renderer. Keep it to a single line. */
  renderRow: (row: Row, highlighted: boolean) => string;
  /** Hints rendered above the list (e.g. "Enter inspect · R run · Esc back"). */
  hintLine?: string;
  /** Fires when the user presses Enter on a row. */
  onSelect?: (row: Row, index: number) => void;
  /**
   * Per-key action map. Keys are single lowercase characters
   * (or `enter` / `escape`); the value receives the highlighted row.
   * Unknown keys are ignored. `escape` typically dismisses the pane.
   */
  onAction?: (key: string, row: Row | null, index: number) => void;
  /**
   * Default `false`. When true, arrow keys wrap from the last row
   * back to the first (and vice versa) instead of clamping at edges.
   */
  wrap?: boolean;
  /** Max number of rows shown at once. Excess rows scroll. Default 10. */
  pageSize?: number;
}

export function InteractiveList<Row>(props: InteractiveListProps<Row>): React.JSX.Element {
  const theme = useTheme();
  const [cursor, setCursor] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const pageSize = Math.max(1, props.pageSize ?? 10);
  const rows = props.rows;
  const move = useCallback(
    (delta: number) => {
      const next = cursor + delta;
      if (next < 0) {
        if (props.wrap && rows.length > 0) setCursor(rows.length - 1);
        else setCursor(0);
        return;
      }
      if (next >= rows.length) {
        if (props.wrap) setCursor(0);
        else setCursor(Math.max(0, rows.length - 1));
        return;
      }
      setCursor(next);
    },
    [cursor, rows.length, props.wrap],
  );
  // Scroll window: keep the highlighted row visible. Adjust the
  // visible slice when the cursor leaves the current window.
  if (cursor < scrollTop) setScrollTop(cursor);
  else if (cursor >= scrollTop + pageSize) setScrollTop(cursor - pageSize + 1);

  useInput((input, key) => {
    if (rows.length === 0) {
      if (key.escape) props.onAction?.("escape", null, -1);
      return;
    }
    if (key.upArrow) {
      move(-1);
      return;
    }
    if (key.downArrow) {
      move(1);
      return;
    }
    if (key.return) {
      const row = rows[cursor];
      if (row !== undefined) {
        props.onSelect?.(row, cursor);
        props.onAction?.("enter", row, cursor);
      }
      return;
    }
    if (key.escape) {
      props.onAction?.("escape", null, cursor);
      return;
    }
    if (typeof input === "string" && input.length > 0) {
      const ch = input.toLowerCase();
      const row = rows[cursor] ?? null;
      props.onAction?.(ch, row, cursor);
    }
  });

  const visible = rows.slice(scrollTop, scrollTop + pageSize);
  return (
    <Box flexDirection="column">
      {props.hintLine ? (
        <Box marginBottom={1}>
          <Text color={theme.severity.dim}>{props.hintLine}</Text>
        </Box>
      ) : null}
      {visible.length === 0 ? (
        <Text color={theme.severity.dim}>(no rows)</Text>
      ) : (
        visible.map((row, i) => {
          const absoluteIdx = scrollTop + i;
          const highlighted = absoluteIdx === cursor;
          return (
            <Box key={absoluteIdx}>
              <Text color={highlighted ? theme.role.assistant : theme.severity.dim}>
                {highlighted ? "› " : "  "}
              </Text>
              <Text bold={highlighted}>{props.renderRow(row, highlighted)}</Text>
            </Box>
          );
        })
      )}
      {rows.length > pageSize ? (
        <Box marginTop={1}>
          <Text color={theme.severity.dim}>
            {cursor + 1} / {rows.length}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
