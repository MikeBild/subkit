import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";

export interface DiffHunkLine {
  kind: "added" | "removed" | "context";
  text: string;
}

export interface DiffHunk {
  id: string;
  label: string;
  lines: DiffHunkLine[];
}

export interface DiffApproverProps {
  hunks: DiffHunk[];
  onAccept: (selectedIds: string[]) => void;
  onReject: (rejectedIds: string[]) => void;
  onAbort?: () => void;
  initialSelected?: string[];
  maxLinesPerHunk?: number;
}

export function DiffApprover({
  hunks,
  onAccept,
  onReject,
  onAbort,
  initialSelected,
  maxLinesPerHunk = 8,
}: DiffApproverProps): React.ReactElement {
  const tokens = useTheme();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected ?? hunks.map((h) => h.id)),
  );

  const safeCursor = Math.min(cursor, Math.max(0, hunks.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      onAbort?.();
      return;
    }
    if (key.return) {
      const accepted = hunks.filter((h) => selected.has(h.id)).map((h) => h.id);
      const rejected = hunks.filter((h) => !selected.has(h.id)).map((h) => h.id);
      onAccept(accepted);
      onReject(rejected);
      return;
    }
    if (input === " ") {
      const id = hunks[safeCursor]?.id;
      if (id) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }
      return;
    }
    if (input === "a" || input === "A") {
      setSelected(new Set(hunks.map((h) => h.id)));
      return;
    }
    if (input === "n" || input === "N") {
      setSelected(new Set());
      return;
    }
    if (key.tab && key.shift) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.tab) {
      setCursor((c) => Math.min(hunks.length - 1, c + 1));
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(hunks.length - 1, c + 1));
  });

  const summary = useMemo(() => {
    const accepted = selected.size;
    return `${accepted}/${hunks.length} hunks selected`;
  }, [selected, hunks]);

  if (hunks.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={tokens.severity.dim}>nothing to apply — no hunks proposed</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={tokens.accent.primary} bold>
          ▸ approve diff
        </Text>
        <Text color={tokens.severity.dim}>
          {" "}
          — {summary} · space toggles · a=all n=none enter applies esc cancels
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {hunks.map((h, i) => (
          <HunkRow
            key={h.id}
            hunk={h}
            active={i === safeCursor}
            selected={selected.has(h.id)}
            maxLines={maxLinesPerHunk}
          />
        ))}
      </Box>
    </Box>
  );
}

function HunkRow({
  hunk,
  active,
  selected,
  maxLines,
}: {
  hunk: DiffHunk;
  active: boolean;
  selected: boolean;
  maxLines: number;
}): React.ReactElement {
  const tokens = useTheme();
  const visibleLines = hunk.lines.slice(0, maxLines);
  const overflow = Math.max(0, hunk.lines.length - maxLines);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={active ? tokens.accent.primary : tokens.severity.dim}>
          {active ? "▶" : " "}
        </Text>
        <Text> </Text>
        <Text color={selected ? tokens.badge.ok : tokens.severity.dim} bold>
          [{selected ? "x" : " "}]
        </Text>
        <Text> </Text>
        <Text color={active ? tokens.accent.primary : tokens.emphasis.normal} bold={active}>
          {hunk.label}
        </Text>
      </Box>
      <Box flexDirection="column" paddingLeft={4}>
        {visibleLines.map((line, idx) => {
          const c =
            line.kind === "added"
              ? tokens.diff.added
              : line.kind === "removed"
                ? tokens.diff.removed
                : tokens.diff.context;
          const prefix = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
          return (
            <Text key={`${hunk.id}-${idx}`} color={c}>
              {prefix} {line.text}
            </Text>
          );
        })}
        {overflow > 0 ? <Text color={tokens.severity.dim}>(+{overflow} more lines)</Text> : null}
      </Box>
    </Box>
  );
}
