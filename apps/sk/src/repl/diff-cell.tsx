// Inline unified-diff renderer — codex `PatchHistoryCell` parity.
//
// Engine pre-computes line hunks (`apps/engine/src/conversations/diff-util.ts`)
// and ships them as a `diff` TurnEvent; this component paints the
// gutter + content with theme colors.
//
// Long diffs collapse: only the first 12 lines render by default, with
// a footer hint pointing at Ctrl-T to open the full transcript pager.
// Mirrors codex's "5-line max + ctrl+t" information-density rule.

import { Box, Text } from "ink";
import type React from "react";
import { memo, useMemo } from "react";

export interface DiffCardProps {
  title: string;
  language: "json" | "yaml" | "text";
  hunks: ReadonlyArray<{ kind: "+" | "-" | " "; text: string }>;
  /** When true the cell renders every hunk; otherwise truncates to
   *  `maxLines`. The pager passes true; the inline transcript leaves
   *  it false unless the user explicitly toggles. */
  expanded?: boolean;
  /** Default 12 lines for the inline cell. */
  maxLines?: number;
}

const PHASE_GLYPH: Record<"+" | "-" | " ", string> = {
  "+": "+",
  "-": "-",
  " ": " ",
};

const DiffCardImpl: React.FC<DiffCardProps> = ({
  title,
  language,
  hunks,
  expanded = false,
  maxLines = 12,
}) => {
  const counts = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const h of hunks) {
      if (h.kind === "+") added++;
      else if (h.kind === "-") removed++;
    }
    return { added, removed };
  }, [hunks]);

  const visible = expanded ? hunks : hunks.slice(0, maxLines);
  const truncated = !expanded && hunks.length > maxLines;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="cyan">⌥ </Text>
        <Text bold>{title}</Text>
        <Text color="gray">
          {" · "}
          <Text color="green">+{counts.added}</Text>
          <Text color="gray"> / </Text>
          <Text color="red">−{counts.removed}</Text>
          <Text color="gray">
            {" · "}
            {language}
          </Text>
        </Text>
      </Box>
      {visible.map((hunk, idx) => {
        const color = hunk.kind === "+" ? "green" : hunk.kind === "-" ? "red" : "gray";
        return (
          <Box key={`hunk-${idx}`}>
            <Text color={color} dimColor={hunk.kind === " "}>
              {PHASE_GLYPH[hunk.kind]} {hunk.text}
            </Text>
          </Box>
        );
      })}
      {truncated ? (
        <Text color="gray" dimColor>
          … {hunks.length - maxLines} more line{hunks.length - maxLines === 1 ? "" : "s"} · ctrl-t
          for full diff
        </Text>
      ) : null}
    </Box>
  );
};

export const DiffCard = memo(DiffCardImpl);
DiffCard.displayName = "DiffCard";
