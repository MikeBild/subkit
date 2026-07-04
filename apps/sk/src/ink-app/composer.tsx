// ---------- Composer ----------
//
// Bordered-input layout:
//
//   ─────────────────────────────────────────
//   ❯ <typed text><blinking cursor>
//   ─────────────────────────────────────────
//
// The horizontal rules render `─` repeated to the terminal width so the
// composer frame follows window resizes. When the app is waiting on a
// turn, the `❯` glyph rotates through SPINNER_FRAMES instead of
// blinking — same spinner verbs the ToolCard uses, so the REPL feels
// cohesive.

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useStdout } from "ink";
import type React from "react";
import { memo, useEffect, useMemo, useState } from "react";
import { firstGrapheme } from "../repl/grapheme.ts";
import { cursorPosition, type InputBuffer, splitLines } from "../repl/input-buffer.ts";
import { type PersonaProbe, searchSlashCommands } from "../slash.ts";
import { SPINNER_FRAMES } from "./transcript-cells.tsx";

export const DEFAULT_RULE_WIDTH = 80;

interface ComposerProps {
  input: InputBuffer;
  busy: boolean;
  placeholder?: string;
}

export const Composer: React.FC<ComposerProps> = memo(({ input, busy, placeholder }) => {
  const theme = useTheme();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? DEFAULT_RULE_WIDTH;
  const [cursorOn, setCursorOn] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setCursorOn((c) => !c), 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((t) => t + 1), 80);
    return () => clearInterval(id);
  }, [busy]);
  const ruleWidth = Math.max(8, Math.min(columns, 160));
  const rule = "─".repeat(ruleWidth);
  const glyph = busy ? (SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "⣾") : "❯";

  const { row, column } = cursorPosition(input);
  const lines = splitLines(input.value);
  const isEmpty = input.value.length === 0;
  const cursorChar = cursorOn ? "▊" : "·";
  const cursorColor = cursorOn ? theme.role.assistant : theme.severity.dim;
  const prefixColor = busy ? theme.severity.warning : theme.role.assistant;

  // Ghost text rides the LAST line only, and only when the cursor sits
  // at the end of input. Anywhere else (mid-edit, multi-line authoring)
  // we don't want a dimmed sibling stealing visual attention.
  const ghost = input.ghost;
  const showGhost = Boolean(
    ghost &&
      ghost.consumed < ghost.text.length &&
      row === lines.length - 1 &&
      column === (lines[row]?.length ?? 0),
  );
  const ghostRemainder = showGhost && ghost ? ghost.text.slice(ghost.consumed) : "";
  const ghostFirst = showGhost ? firstGrapheme(ghostRemainder) : "";
  const ghostRest = showGhost ? ghostRemainder.slice(ghostFirst.length) : "";

  return (
    <Box flexDirection="column">
      <Text color={theme.severity.dim}>{rule}</Text>
      {lines.map((line, i) => {
        const prefix = i === 0 ? `${glyph} ` : "  ";
        const before = i === row ? line.slice(0, column) : line;
        const after = i === row ? line.slice(column) : "";
        const isGhostRow = showGhost && i === row;
        return (
          <Box key={`composer-row-${i}`}>
            <Text color={prefixColor} bold>
              {prefix}
            </Text>
            {i === 0 && isEmpty && !showGhost && placeholder ? (
              <Text color={theme.severity.dim}>{placeholder}</Text>
            ) : (
              <>
                <Text>{before}</Text>
                {isGhostRow ? (
                  <>
                    <Text inverse>{ghostFirst}</Text>
                    <Text color={theme.severity.dim}>{ghostRest}</Text>
                  </>
                ) : i === row ? (
                  <Text color={cursorColor}>{cursorChar}</Text>
                ) : null}
                <Text>{after}</Text>
              </>
            )}
          </Box>
        );
      })}
      <Text color={theme.severity.dim}>{rule}</Text>
    </Box>
  );
});
Composer.displayName = "Composer";

// ---------- Slash-command suggestions footer ----------

interface SuggestionListProps {
  query: string;
  probe: PersonaProbe;
  selectedIndex: number;
}

export const SuggestionList: React.FC<SuggestionListProps> = memo(
  ({ query, probe, selectedIndex }) => {
    const matches = useMemo(() => searchSlashCommands(query, probe, 5), [query, probe]);
    if (!query.startsWith("/") || matches.length === 0) return null;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>matches (↑/↓ select · Tab complete · Enter run):</Text>
        {matches.map((cmd, idx) => {
          const isSelected = idx === selectedIndex;
          return (
            <Box key={`sug-${cmd.name}`}>
              {isSelected ? <Text color="cyan">▸ </Text> : <Text> </Text>}
              <Text color="cyan" bold={isSelected}>
                /{cmd.name}
              </Text>
              <Text dimColor> — {cmd.help}</Text>
            </Box>
          );
        })}
      </Box>
    );
  },
);
SuggestionList.displayName = "SuggestionList";
