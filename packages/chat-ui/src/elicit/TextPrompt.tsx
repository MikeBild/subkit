// askUser.text prompt — single-line free-form text input. Uses the
// single-owner keystroke model (parent `useInput` + `ControlledTextField`
// display) so its behavior is consistent with every other ask-user
// prompt. No competing `useInput` from `@inkjs/ui`'s TextInput.
//
// Key map:
//   Enter            — validate with `validationRegex` and submit.
//   Esc              — onCancel if provided.
//   Backspace/Delete — pop last char.
//   Printable char   — append.
//
// `multiline` is accepted from the input payload but not yet honored
// (single-line only in this release); tracked as future work.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { useTheme } from "../theme/Provider.tsx";
import { ControlledTextField } from "./ControlledTextField.tsx";

export interface TextPromptProps {
  question: string;
  placeholder?: string | undefined;
  multiline?: boolean | undefined;
  /** Optional regex the submitted text must match. */
  validationRegex?: string | undefined;
  onResponse: (value: { text: string }) => void;
  onCancel?: (() => void) | undefined;
  inputDisabled?: boolean | undefined;
}

function isPrintable(input: string, key: { ctrl: boolean; meta: boolean }): boolean {
  if (key.ctrl || key.meta) return false;
  if (input.length !== 1) return false;
  const code = input.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

export const TextPrompt: React.FC<TextPromptProps> = ({
  question,
  placeholder,
  validationRegex,
  onResponse,
  onCancel,
  inputDisabled,
}) => {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.return) {
        if (validationRegex) {
          try {
            const re = new RegExp(validationRegex);
            if (!re.test(value)) {
              setError(`must match ${validationRegex}`);
              return;
            }
          } catch {
            // invalid regex — skip validation rather than blocking the user
          }
        }
        onResponse({ text: value });
        return;
      }
      if (key.backspace || key.delete) {
        setError(null);
        setValue((v) => v.slice(0, -1));
        return;
      }
      if (isPrintable(input, key)) {
        setError(null);
        setValue((v) => v + input);
      }
    },
    { isActive: !inputDisabled },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.severity.info} paddingX={1}>
      <Text bold>{question}</Text>
      {inputDisabled ? (
        <Text color={theme.severity.dim}>{placeholder ?? "(input disabled)"}</Text>
      ) : (
        <ControlledTextField value={value} focused={true} placeholder={placeholder} />
      )}
      {error ? <Text color={theme.severity.error}>{error}</Text> : null}
      <Text color={theme.severity.dim}>Enter to submit{onCancel ? " · Esc to cancel" : ""}</Text>
    </Box>
  );
};
