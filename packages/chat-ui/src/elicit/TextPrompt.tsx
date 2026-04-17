// askUser.text prompt — single- or multi-line free-form text input.

import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import type React from "react";
import { useState } from "react";
import { useTheme } from "../theme/Provider.tsx";

export interface TextPromptProps {
  question: string;
  placeholder?: string | undefined;
  multiline?: boolean | undefined;
  /** Optional regex the submitted text must match. */
  validationRegex?: string | undefined;
  onResponse: (value: { text: string }) => void;
  inputDisabled?: boolean | undefined;
}

export const TextPrompt: React.FC<TextPromptProps> = ({
  question,
  placeholder,
  validationRegex,
  onResponse,
  inputDisabled,
}) => {
  const theme = useTheme();
  const [error, setError] = useState<string | null>(null);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.severity.info} paddingX={1}>
      <Text bold>{question}</Text>
      {inputDisabled ? (
        <Text color={theme.severity.dim}>{placeholder ?? "(input disabled)"}</Text>
      ) : (
        <TextInput
          placeholder={placeholder ?? ""}
          onSubmit={(value) => {
            if (validationRegex) {
              try {
                const re = new RegExp(validationRegex);
                if (!re.test(value)) {
                  setError(`must match ${validationRegex}`);
                  return;
                }
              } catch {
                /* invalid regex — skip validation */
              }
            }
            onResponse({ text: value });
          }}
        />
      )}
      {error ? <Text color={theme.severity.error}>{error}</Text> : null}
      <Text color={theme.severity.dim}>Enter to submit · Esc to cancel</Text>
    </Box>
  );
};
