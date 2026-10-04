import { Box, Text } from "ink";
import type React from "react";
import { memo, useMemo } from "react";

export interface DiffCardProps {
  title: string;
  language: "json" | "yaml" | "text";
  hunks: ReadonlyArray<{ kind: "+" | "-" | " "; text: string }>;
  expanded?: boolean;
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
