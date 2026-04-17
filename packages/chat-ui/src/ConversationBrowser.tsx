// Modal browser for picking a past conversation to resume.
//
// Rendered by the host when the user hits `/resume`. Arrow keys
// navigate the list, Enter selects, Esc dismisses. The list is
// host-provided (the engine returns it) so we don't have to know
// anything about how conversations are fetched or paginated.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo, useState } from "react";
import { Pane } from "./Pane.tsx";
import { useTheme } from "./theme/Provider.tsx";

export interface ConversationItem {
  id: string;
  title: string | null;
  updated_at: string;
  status?: string | null;
}

export interface ConversationBrowserProps {
  items: readonly ConversationItem[];
  onSelect: (id: string) => void;
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

export const ConversationBrowser: React.FC<ConversationBrowserProps> = ({
  items,
  onSelect,
  onDismiss,
  title = "resume conversation",
  inputDisabled,
}) => {
  const theme = useTheme();
  const [focused, setFocused] = useState(0);
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const q = filter.toLowerCase();
    if (q.length === 0) return items;
    return items.filter(
      (it) => (it.title ?? "").toLowerCase().includes(q) || it.id.toLowerCase().includes(q),
    );
  }, [items, filter]);

  useInput(
    (ch, key) => {
      if (key.return) {
        const pick = visible[focused];
        if (pick) onSelect(pick.id);
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
      // Accept multi-char chunks too (ink-testing-library batches
      // sequential writes into a single `input` event); filter out
      // control-byte noise so Esc / Enter / arrow keys don't leak in.
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
      subtitle={`${visible.length} / ${items.length}`}
      {...(onDismiss ? { onDismiss } : {})}
      {...(inputDisabled !== undefined ? { inputDisabled } : {})}
      footer="↑/↓ to move · Enter to open · type to filter · Esc to close"
    >
      {filter.length > 0 ? (
        <Box>
          <Text color={theme.severity.dim}>filter: </Text>
          <Text>{filter}</Text>
        </Box>
      ) : null}
      {visible.length === 0 ? (
        <Text color={theme.severity.dim}>no conversations</Text>
      ) : (
        visible.slice(0, 15).map((it, i) => {
          const marker = i === focused ? "▶ " : "  ";
          const titleOrId = it.title ?? it.id.slice(0, 8);
          const ts = it.updated_at.replace("T", " ").slice(0, 16);
          return (
            <Box key={it.id}>
              <Text {...(i === focused ? { color: theme.role.user, bold: true } : {})}>
                {marker}
                {titleOrId}
              </Text>
              <Text color={theme.severity.dim}>
                {"  "}· {ts}
                {it.status ? ` · ${it.status}` : ""}
              </Text>
            </Box>
          );
        })
      )}
    </Pane>
  );
};
