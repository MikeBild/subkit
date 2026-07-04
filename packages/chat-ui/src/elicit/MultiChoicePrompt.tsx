// askUser.multi prompt — multi-select from a list. Space toggles,
// Enter submits the current set. Respects optional `min` / `max`
// bounds from the tool input.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { useTheme } from "../theme/Provider.tsx";

export interface MultiChoiceOption {
  value: string;
  label: string;
  description?: string;
}

export interface MultiChoicePromptProps {
  question: string;
  options: MultiChoiceOption[];
  min?: number | undefined;
  max?: number | undefined;
  onResponse: (value: { values: string[] }) => void;
  inputDisabled?: boolean | undefined;
}

export const MultiChoicePrompt: React.FC<MultiChoicePromptProps> = ({
  question,
  options,
  min,
  max,
  onResponse,
  inputDisabled,
}) => {
  const theme = useTheme();
  const [focused, setFocused] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useInput(
    (input, key) => {
      if (options.length === 0) return;
      if (key.upArrow) setFocused((i) => (i - 1 + options.length) % options.length);
      else if (key.downArrow) setFocused((i) => (i + 1) % options.length);
      else if (input === " ") {
        const opt = options[focused];
        if (!opt) return;
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(opt.value)) next.delete(opt.value);
          else {
            if (max !== undefined && next.size >= max) return prev;
            next.add(opt.value);
          }
          return next;
        });
      } else if (key.return) {
        if (min !== undefined && selected.size < min) return;
        onResponse({ values: [...selected] });
      }
    },
    { isActive: !inputDisabled },
  );

  const constraintHint =
    min !== undefined || max !== undefined ? ` (${min ?? 0}–${max ?? "∞"})` : "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.severity.info} paddingX={1}>
      <Text bold>
        {question}
        <Text color={theme.severity.dim}>{constraintHint}</Text>
      </Text>
      {options.map((opt, i) => {
        const isFocused = i === focused;
        const isSelected = selected.has(opt.value);
        return (
          <Box key={opt.value}>
            <Text {...(isFocused ? { color: theme.role.user } : {})}>
              {isFocused ? "▶ " : "  "}
              {isSelected ? "[✓] " : "[ ] "}
              {opt.label}
            </Text>
            {opt.description ? <Text color={theme.severity.dim}> — {opt.description}</Text> : null}
          </Box>
        );
      })}
      <Text color={theme.severity.dim}>↑/↓ to move · space to toggle · Enter to submit</Text>
    </Box>
  );
};
