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
  last_message_role?: string | null;
  last_message_excerpt?: string | null;
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

function truncate(text: string, max = 72): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= max) return squashed;
  return `${squashed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso.replace("T", " ").slice(0, 16);
  const deltaMs = then - Date.now();
  const absSeconds = Math.round(Math.abs(deltaMs) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absSeconds < 60) return rtf.format(Math.round(deltaMs / 1000), "second");
  const absMinutes = Math.round(absSeconds / 60);
  if (absMinutes < 60) return rtf.format(Math.round(deltaMs / 60_000), "minute");
  const absHours = Math.round(absMinutes / 60);
  if (absHours < 48) return rtf.format(Math.round(deltaMs / 3_600_000), "hour");
  const absDays = Math.round(absHours / 24);
  if (absDays < 30) return rtf.format(Math.round(deltaMs / 86_400_000), "day");
  const absMonths = Math.round(absDays / 30);
  if (absMonths < 18) return rtf.format(Math.round(deltaMs / (30 * 86_400_000)), "month");
  return rtf.format(Math.round(deltaMs / (365 * 86_400_000)), "year");
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
      (it) =>
        (it.title ?? "").toLowerCase().includes(q) ||
        (it.last_message_excerpt ?? "").toLowerCase().includes(q) ||
        it.id.toLowerCase().includes(q),
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
      footer="↑/↓ to move · Enter to open · filter by title/excerpt/id · Esc to close"
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
          const shortId = it.id.slice(0, 8);
          const titleOrId = truncate(it.title ?? it.last_message_excerpt ?? shortId, 56);
          const excerpt =
            it.last_message_excerpt && it.last_message_excerpt !== it.title
              ? truncate(it.last_message_excerpt, 68)
              : null;
          const role = it.last_message_role ? truncate(it.last_message_role, 16) : null;
          const relative = formatRelativeTime(it.updated_at);
          const status = it.status ?? "active";
          const statusColor =
            status === "awaiting_input"
              ? theme.severity.warning
              : status === "committed"
                ? theme.emphasis.added
                : status === "abandoned"
                  ? theme.severity.error
                  : theme.severity.dim;
          return (
            <Box key={it.id} flexDirection="column" marginBottom={1}>
              <Box>
                <Text {...(i === focused ? { color: theme.role.user, bold: true } : {})}>
                  {marker}
                  {titleOrId}
                </Text>
                <Text color={theme.severity.dim}> · </Text>
                <Text color={statusColor}>{status}</Text>
                <Text color={theme.severity.dim}> · {shortId}</Text>
              </Box>
              {excerpt ? (
                <Box marginLeft={2}>
                  <Text color={theme.severity.dim}>
                    {role ? `${role} · ` : ""}
                    {excerpt}
                  </Text>
                </Box>
              ) : null}
              <Box marginLeft={2}>
                <Text color={theme.severity.dim}>{relative}</Text>
                <Text color={theme.severity.dim}> · </Text>
                <Text color={theme.severity.dim}>
                  {it.updated_at.replace("T", " ").slice(0, 16)}
                </Text>
              </Box>
            </Box>
          );
        })
      )}
    </Pane>
  );
};
