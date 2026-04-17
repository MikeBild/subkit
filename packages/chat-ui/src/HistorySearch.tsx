// Ctrl-R history-search modal — fuzzy-filter prior prompts from an
// in-memory ring, pick one with Enter. The host owns the history
// array (the sk REPL keeps it in `historyRef`); this component is a
// pure view over it.
//
// Keyboard: arrow keys to move, Enter to pick, Esc to dismiss, typing
// filters. Multi-char paste chunks are folded in so ink-testing-
// library's batched writes exercise the same path as real keystrokes.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo, useState } from "react";
import { Pane } from "./Pane.tsx";
import { useTheme } from "./theme/Provider.tsx";

export interface HistorySearchProps {
  /** Prior prompts, oldest first. Typical: the REPL's prompt-ring. */
  entries: readonly string[];
  /** Called with the selected prompt when the user hits Enter. */
  onSelect: (prompt: string) => void;
  onDismiss?: () => void;
  title?: string;
  inputDisabled?: boolean;
}

function containsControlChar(s: string): boolean {
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const HistorySearch: React.FC<HistorySearchProps> = ({
  entries,
  onSelect,
  onDismiss,
  title = "history",
  inputDisabled,
}) => {
  const theme = useTheme();
  const [filter, setFilter] = useState("");
  const [focused, setFocused] = useState(0);

  const visible = useMemo(() => {
    const q = filter.toLowerCase();
    // Most-recent-first — how users expect Ctrl-R to work.
    const ordered = [...entries].reverse();
    if (q.length === 0) return ordered;
    return ordered.filter((e) => e.toLowerCase().includes(q));
  }, [entries, filter]);

  useInput(
    (ch, key) => {
      if (key.return) {
        const pick = visible[focused];
        if (pick !== undefined) onSelect(pick);
        return;
      }
      if (key.upArrow) {
        setFocused((i) => (i - 1 + visible.length) % Math.max(1, visible.length));
        return;
      }
      if (key.downArrow) {
        setFocused((i) => (i + 1) % Math.max(1, visible.length));
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1));
        return;
      }
      if (
        ch &&
        ch.length > 0 &&
        !key.ctrl &&
        !key.meta &&
        !key.escape &&
        !key.return &&
        !key.upArrow &&
        !key.downArrow &&
        !containsControlChar(ch)
      ) {
        setFilter((f) => f + ch);
      }
    },
    { isActive: !inputDisabled },
  );

  return (
    <Pane
      title={title}
      subtitle={`${visible.length} / ${entries.length}`}
      {...(onDismiss ? { onDismiss } : {})}
      {...(inputDisabled !== undefined ? { inputDisabled } : {})}
      footer="↑/↓ to move · Enter to pick · type to filter · Esc to close"
    >
      {filter.length > 0 ? (
        <Box>
          <Text color={theme.severity.dim}>filter: </Text>
          <Text>{filter}</Text>
        </Box>
      ) : null}
      {visible.length === 0 ? (
        <Text color={theme.severity.dim}>no matching prompts</Text>
      ) : (
        visible.slice(0, 12).map((entry, i) => {
          const marker = i === focused ? "▶ " : "  ";
          const truncated = entry.length > 90 ? `${entry.slice(0, 87)}…` : entry;
          return (
            <Box key={`hs-${i}-${entry.slice(0, 12)}`}>
              <Text {...(i === focused ? { color: theme.role.user, bold: true } : {})}>
                {marker}
                {truncated}
              </Text>
            </Box>
          );
        })
      )}
    </Pane>
  );
};
