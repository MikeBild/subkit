// Slash command palette — opens below the prompt when the user
// types `/`. Fuzzy-matches the current token against command
// `name` + `aliases` and shows one-line descriptions. Arrow/Tab to
// move, Enter to insert, Esc to dismiss.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo, useState } from "react";
import { useTheme } from "./theme/Provider.tsx";

export interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
}

export interface SlashPaletteProps {
  commands: SlashCommand[];
  /** The current prompt text (everything after `/`). */
  query: string;
  onSelect: (name: string) => void;
  onDismiss: () => void;
  inputDisabled?: boolean | undefined;
}

export const SlashPalette: React.FC<SlashPaletteProps> = ({
  commands,
  query,
  onSelect,
  onDismiss,
  inputDisabled,
}) => {
  const theme = useTheme();
  const matches = useMemo(() => fuzzyMatch(commands, query), [commands, query]);
  const [focused, setFocused] = useState(0);

  useInput(
    (_input, key) => {
      if (matches.length === 0) return;
      if (key.upArrow) setFocused((i) => (i - 1 + matches.length) % matches.length);
      else if (key.downArrow || key.tab) setFocused((i) => (i + 1) % matches.length);
      else if (key.return) {
        const cmd = matches[focused];
        if (cmd) onSelect(cmd.name);
      } else if (key.escape) {
        onDismiss();
      }
    },
    { isActive: !inputDisabled },
  );

  if (matches.length === 0) {
    return (
      <Box borderStyle="single" borderColor={theme.severity.dim} paddingX={1}>
        <Text color={theme.severity.dim}>no matching command</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.severity.dim} paddingX={1}>
      {matches.slice(0, 8).map((cmd, i) => (
        <Box key={cmd.name}>
          <Text {...(i === focused ? { color: theme.role.user } : {})}>
            {i === focused ? "▶ " : "  "}/{cmd.name}
          </Text>
          <Text color={theme.severity.dim}> — {cmd.description}</Text>
        </Box>
      ))}
      <Text color={theme.severity.dim}>↑/↓/Tab to move · Enter to insert · Esc to dismiss</Text>
    </Box>
  );
};

function fuzzyMatch(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (q.length === 0) return commands;
  const scored: Array<{ cmd: SlashCommand; score: number }> = [];
  for (const cmd of commands) {
    const hay = [cmd.name, ...(cmd.aliases ?? [])].join(" ").toLowerCase();
    const idx = hay.indexOf(q);
    if (idx === -1) continue;
    scored.push({ cmd, score: -idx - (cmd.name.toLowerCase().startsWith(q) ? 1000 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.cmd);
}
