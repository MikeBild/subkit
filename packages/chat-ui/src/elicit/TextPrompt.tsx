import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { useTheme } from "../theme/Provider.tsx";
import { ControlledTextField } from "./ControlledTextField.tsx";

export interface TextPromptProps {
  question: string;
  placeholder?: string | undefined;
  multiline?: boolean | undefined;
  validationRegex?: string | undefined;
  defaultValue?: string | undefined;
  onResponse: (value: { text: string }) => void;
  onCancel?: (() => void) | undefined;
  inputDisabled?: boolean | undefined;
}

function isPrintableChar(code: number): boolean {
  return code !== 0x7f && (code >= 0x20 || code >= 0x80);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: literal ESC byte is exactly what we strip — RegExp(...) constructor triggers the opposite "prefer literal" rule.
const BRACKETED_PASTE_RE = /\u001b\[20[01]~/g;

function sanitizeInputChunk(raw: string): string {
  const unwrapped = raw.replace(BRACKETED_PASTE_RE, "");
  const singleLine = unwrapped.replace(/[\r\n\t]+/g, "");
  let out = "";
  for (const ch of singleLine) {
    const code = ch.codePointAt(0) ?? 0;
    if (isPrintableChar(code)) out += ch;
  }
  return out;
}

function isPrintable(input: string, key: { ctrl: boolean; meta: boolean }): boolean {
  if (key.ctrl || key.meta) return false;
  if (input.length !== 1) return false;
  const code = input.charCodeAt(0);
  return isPrintableChar(code);
}

export const TextPrompt: React.FC<TextPromptProps> = ({
  question,
  placeholder,
  validationRegex,
  defaultValue,
  onResponse,
  onCancel,
  inputDisabled,
}) => {
  const theme = useTheme();
  const [value, setValue] = useState(defaultValue ?? "");
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
          } catch {}
        }
        onResponse({ text: value });
        return;
      }
      if (key.backspace || key.delete) {
        setError(null);
        setValue((v) => v.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 1) {
        const clean = sanitizeInputChunk(input);
        if (clean.length > 0) {
          setError(null);
          setValue((v) => v + clean);
        }
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
