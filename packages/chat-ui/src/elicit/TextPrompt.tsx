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
//   Paste (Cmd+V / bracketed paste) — append the full clipboard buffer
//     as one chunk (stripping control chars + bracketed-paste wrappers
//     + newlines since this is a single-line field). Without this a
//     40-char token is dropped because the terminal delivers the
//     entire paste as one >1-char `input`, which the old isPrintable
//     rejected.
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
  /** Optional pre-filled value rendered as the initial buffer — the
   *  user confirms with Enter or edits instead of retyping. */
  defaultValue?: string | undefined;
  onResponse: (value: { text: string }) => void;
  onCancel?: (() => void) | undefined;
  inputDisabled?: boolean | undefined;
}

function isPrintableChar(code: number): boolean {
  // Printable ASCII (0x20 space … 0x7e ~) + anything above 0x7f so
  // multi-byte UTF-8 tokens survive. DEL (0x7f) and C0 control chars
  // are dropped.
  return code !== 0x7f && (code >= 0x20 || code >= 0x80);
}

// Built via `new RegExp` with a unicode escape so the source file
// doesn't embed a literal ESC (0x1b) byte that lint flags as a control
// char in regex-literal syntax. Matches `ESC [ 200~` / `ESC [ 201~`
// — the bracketed-paste wrappers terminals emit around a paste.
// biome-ignore lint/suspicious/noControlCharactersInRegex: literal ESC byte is exactly what we strip — RegExp(...) constructor triggers the opposite "prefer literal" rule.
const BRACKETED_PASTE_RE = /\u001b\[20[01]~/g;

/**
 * Sanitize a raw input chunk coming from Ink — strip bracketed-paste
 * wrappers (ESC [ 200 ~ … ESC [ 201 ~), newlines (single-line field),
 * and any remaining control characters. Returns the pasted text ready
 * to append to the field's value.
 */
function sanitizeInputChunk(raw: string): string {
  // Strip bracketed-paste markers if the terminal forwarded them raw.
  const unwrapped = raw.replace(BRACKETED_PASTE_RE, "");
  // Drop newlines / tabs — single-line input. Keep spaces.
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
      // Paste: terminal delivers the whole clipboard as one chunk.
      // Sanitize + append the full buffer in a single state update.
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
