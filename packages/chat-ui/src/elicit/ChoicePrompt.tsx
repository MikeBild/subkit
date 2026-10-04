import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { useTheme } from "../theme/Provider.tsx";

export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
}

export interface ChoicePromptProps {
  question: string;
  options: ChoiceOption[];
  defaultValue?: string | undefined;
  onResponse: (value: { value: string }) => void;
  inputDisabled?: boolean | undefined;
}

export const ChoicePrompt: React.FC<ChoicePromptProps> = ({
  question,
  options,
  defaultValue,
  onResponse,
  inputDisabled,
}) => {
  const theme = useTheme();
  const defaultIndex = defaultValue ? options.findIndex((o) => o.value === defaultValue) : -1;
  const [focused, setFocused] = useState(defaultIndex >= 0 ? defaultIndex : 0);

  useInput(
    (input, key) => {
      if (options.length === 0) return;
      if (key.upArrow) setFocused((i) => (i - 1 + options.length) % options.length);
      else if (key.downArrow) setFocused((i) => (i + 1) % options.length);
      else if (key.return) {
        const opt = options[focused];
        if (opt) onResponse({ value: opt.value });
      } else {
        const digit = Number.parseInt(input, 10);
        if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
          const opt = options[digit - 1];
          if (opt) onResponse({ value: opt.value });
        }
      }
    },
    { isActive: !inputDisabled },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.severity.info} paddingX={1}>
      <Text bold>{question}</Text>
      {options.map((opt, i) => {
        const isFocused = i === focused;
        return (
          <Box key={opt.value}>
            <Text {...(isFocused ? { color: theme.role.user } : {})}>
              {isFocused ? "▶ " : "  "}
              {i + 1}. {opt.label}
            </Text>
            {opt.description ? <Text color={theme.severity.dim}> — {opt.description}</Text> : null}
          </Box>
        );
      })}
      <Text color={theme.severity.dim}>↑/↓ to move · digit or Enter to select</Text>
    </Box>
  );
};
