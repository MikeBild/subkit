// A display-only, fully-controlled text field for elicit prompts.
// Value lives in the parent; the component renders it plus a
// reverse-video cursor glyph when focused. No internal `useInput` —
// every keystroke is dispatched
// by the owning prompt's single `useInput` hook, which is the only
// reliable way to avoid the Tab-key conflict that stock Ink has when
// multiple `useInput` hooks are active simultaneously.

import { Text } from "ink";
import type React from "react";

import { useTheme } from "../theme/Provider.tsx";

export interface ControlledTextFieldProps {
  value: string;
  focused: boolean;
  placeholder?: string | undefined;
  /** If "password", render each char as •. */
  mask?: "none" | "password" | undefined;
}

export const ControlledTextField: React.FC<ControlledTextFieldProps> = ({
  value,
  focused,
  placeholder,
  mask = "none",
}) => {
  const theme = useTheme();
  const display = mask === "password" ? "•".repeat(value.length) : value;
  const isEmpty = value.length === 0;

  if (!focused) {
    return <Text color={theme.severity.dim}>{isEmpty ? (placeholder ?? "") : display}</Text>;
  }

  if (isEmpty) {
    return (
      <Text>
        <Text inverse> </Text>
        <Text color={theme.severity.dim}>{placeholder ? ` ${placeholder}` : ""}</Text>
      </Text>
    );
  }

  return (
    <Text>
      {display}
      <Text inverse> </Text>
    </Text>
  );
};
