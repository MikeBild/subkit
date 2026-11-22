import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useMemo, useState } from "react";

interface InlineHistorySearchProps {
  entries: readonly string[];
  onCommit: (prompt: string) => void;
  onCancel: () => void;
  inputDisabled?: boolean;
}

function scoreEntry(entry: string, query: string): number {
  if (query.length === 0) return 0;
  const hay = entry.toLowerCase();
  const q = query.toLowerCase();
  const idx = hay.indexOf(q);
  if (idx === -1) return Number.POSITIVE_INFINITY;
  return idx + entry.length * 0.001;
}

export function rankEntries(entries: readonly string[], query: string): string[] {
  const ordered = [...entries].reverse();
  if (query.length === 0) return ordered;
  return ordered
    .map((e) => ({ e, s: scoreEntry(e, query) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s)
    .map((x) => x.e);
}

export const InlineHistorySearch: React.FC<InlineHistorySearchProps> = ({
  entries,
  onCommit,
  onCancel,
  inputDisabled,
}) => {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const matches = useMemo(() => rankEntries(entries, query), [entries, query]);
  const active = matches[cursor];

  useEffect(() => {
    if (cursor >= matches.length) setCursor(0);
  }, [matches.length, cursor]);

  useInput(
    (ch, key) => {
      if (key.escape || (key.ctrl && ch === "g")) {
        onCancel();
        return;
      }
      if (key.return || key.tab) {
        if (active !== undefined) onCommit(active);
        return;
      }
      if (key.upArrow || (key.ctrl && ch === "p")) {
        setCursor((i) => Math.min(matches.length - 1, i + 1));
        return;
      }
      if (key.downArrow || (key.ctrl && ch === "n")) {
        setCursor((i) => Math.max(0, i - 1));
        return;
      }
      if (key.ctrl && ch === "r") {
        setCursor((i) => (i + 1) % Math.max(1, matches.length));
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setCursor(0);
        return;
      }
      if (ch && ch.length > 0 && !key.ctrl && !key.meta) {
        setQuery((q) => q + ch);
        setCursor(0);
      }
    },
    { isActive: !inputDisabled },
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.role.assistant} bold>
          (reverse-i-search)
        </Text>
        <Text color={theme.severity.dim}>
          {" "}
          `<Text>{query}</Text>`:
        </Text>
        <Text> {active ?? ""}</Text>
      </Box>
      <Text color={theme.severity.dim}>
        {matches.length > 0
          ? `${cursor + 1} / ${matches.length} · ↑/↓ or Ctrl-R cycles · Enter commits · Esc cancels`
          : "no matches (type to filter · Esc to cancel)"}
      </Text>
    </Box>
  );
};
