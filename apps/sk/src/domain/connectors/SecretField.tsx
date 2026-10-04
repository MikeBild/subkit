import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface SecretFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (final: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  startMasked?: boolean;
}

const MASK_CHAR = "•";

export function SecretField({
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  startMasked = true,
}: SecretFieldProps): React.ReactElement {
  const tokens = useTheme();
  const [masked, setMasked] = useState(startMasked);
  const [focused, setFocused] = useState(true);

  useInput((input, key) => {
    if (!focused) return;
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.return) {
      onSubmit?.(value);
      setFocused(false);
      return;
    }
    if (key.ctrl && (input === "e" || input === "E")) {
      setMasked((m) => !m);
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      onChange(value + input);
    }
  });

  const display =
    value.length === 0 ? (placeholder ?? "") : masked ? MASK_CHAR.repeat(value.length) : value;
  const isPlaceholder = value.length === 0 && !!placeholder;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={tokens.severity.dim}>{label}: </Text>
        <Text color={isPlaceholder ? tokens.severity.dim : tokens.emphasis.strong}>{display}</Text>
        <Text color={tokens.severity.dim}>{value.length > 0 ? `  (${value.length})` : ""}</Text>
      </Box>
      <Box>
        <Text color={tokens.severity.dim}>
          {masked
            ? "Ctrl+E to reveal · enter to submit · esc cancels"
            : "Ctrl+E to mask · enter to submit · esc cancels"}
        </Text>
      </Box>
    </Box>
  );
}
