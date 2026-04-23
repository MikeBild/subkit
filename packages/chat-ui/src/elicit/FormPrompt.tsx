// askUser.form prompt — vertical stack of typed fields. All input
// flows through a single `useInput` hook owned by this component,
// mirroring the claude-code single-owner pattern. No child component
// registers its own input handler, so Tab/Shift+Tab/Enter cannot be
// swallowed by a nested input (the exact bug `@inkjs/ui`'s TextInput
// produced here prior to this rewrite).
//
// Key map:
//   Tab / Shift+Tab  — cycle focus between fields (wraps).
//   Enter            — validate and submit from any field.
//   Esc              — onCancel if provided.
//   Backspace/Delete — pop last char from focused text/number field.
//   Space            — toggle focused boolean; literal space in text.
//   ← / →            — cycle options on focused select field.
//   Printable char   — append to focused text/number field
//                      (number fields filter to [0-9.\-]).

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { useTheme } from "../theme/Provider.tsx";
import { ControlledTextField } from "./ControlledTextField.tsx";

export interface FormFieldOption {
  value: string;
  label: string;
}

export interface FormField {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "select" | "password";
  options?: FormFieldOption[] | undefined;
  placeholder?: string | undefined;
  required?: boolean | undefined;
  /**
   * When true, the rendered value is masked (bullet characters). `password`
   * fields imply `sensitive: true`. Used by the credential-collection
   * flow so typed secrets never appear on the terminal.
   */
  sensitive?: boolean | undefined;
}

export interface FormPromptProps {
  question: string;
  fields: FormField[];
  onResponse: (value: { values: Record<string, unknown> }) => void;
  onCancel?: (() => void) | undefined;
  inputDisabled?: boolean | undefined;
}

type FieldValues = Record<string, unknown>;

function initialValues(fields: FormField[]): FieldValues {
  const initial: FieldValues = {};
  for (const f of fields) {
    if (f.type === "boolean") initial[f.name] = false;
    else if (f.type === "select" && f.options && f.options.length > 0)
      initial[f.name] = f.options[0]?.value;
    else initial[f.name] = "";
  }
  return initial;
}

function isPrintableChar(code: number): boolean {
  return code !== 0x7f && (code >= 0x20 || code >= 0x80);
}

function isPrintable(input: string, key: { ctrl: boolean; meta: boolean }): boolean {
  if (key.ctrl || key.meta) return false;
  if (input.length !== 1) return false;
  const code = input.charCodeAt(0);
  return isPrintableChar(code);
}

/**
 * Strip bracketed-paste wrappers + control chars from a paste chunk.
 * Single-line form fields strip newlines too; multi-line-aware fields
 * (if ever added) can bypass this.
 */
// Built via `new RegExp` with a unicode escape so the source file
// doesn't embed a literal ESC (0x1b) byte that lint flags as a control
// char in regex-literal syntax.
// biome-ignore lint/suspicious/noControlCharactersInRegex: literal ESC byte is exactly what we strip — RegExp(...) constructor triggers the opposite "prefer literal" rule.
const BRACKETED_PASTE_RE = /\u001b\[20[01]~/g;

function sanitizePasteChunk(raw: string, singleLine: boolean): string {
  const unwrapped = raw.replace(BRACKETED_PASTE_RE, "");
  const preNorm = singleLine ? unwrapped.replace(/[\r\n\t]+/g, "") : unwrapped;
  let out = "";
  for (const ch of preNorm) {
    const code = ch.codePointAt(0) ?? 0;
    if (isPrintableChar(code) || (!singleLine && (code === 0x0a || code === 0x09))) out += ch;
  }
  return out;
}

function isNumericChar(ch: string): boolean {
  return /^[0-9.-]$/.test(ch);
}

function coerce(fields: FormField[], values: FieldValues): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.type === "number" && typeof v === "string") {
      const n = Number(v);
      out[f.name] = Number.isFinite(n) ? n : Number.NaN;
    } else {
      out[f.name] = v;
    }
  }
  return out;
}

function firstInvalidIndex(fields: FormField[], values: FieldValues): number {
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const v = values[f.name];
    if (f.required) {
      if (v === undefined || v === null || v === "") return i;
      if (f.type === "number" && typeof v === "string") {
        const n = Number(v);
        if (!Number.isFinite(n)) return i;
      }
    }
  }
  return -1;
}

export const FormPrompt: React.FC<FormPromptProps> = ({
  question,
  fields,
  onResponse,
  onCancel,
  inputDisabled,
}) => {
  const theme = useTheme();
  const [cursor, setCursor] = useState(0);
  const [values, setValues] = useState<FieldValues>(() => initialValues(fields));
  const [error, setError] = useState<string | null>(null);

  useInput(
    (input, key) => {
      if (fields.length === 0) return;

      if (key.escape) {
        onCancel?.();
        return;
      }

      if (key.tab) {
        setError(null);
        setCursor((i) => {
          const n = fields.length;
          return key.shift ? (i - 1 + n) % n : (i + 1) % n;
        });
        return;
      }

      if (key.return) {
        const idx = firstInvalidIndex(fields, values);
        if (idx >= 0) {
          setError(`Please fill the required field above.`);
          setCursor(idx);
          return;
        }
        onResponse({ values: coerce(fields, values) });
        return;
      }

      const f = fields[cursor];
      if (!f) return;

      if (f.type === "boolean") {
        if (input === " ") {
          setError(null);
          setValues((v) => ({ ...v, [f.name]: !v[f.name] }));
        }
        return;
      }

      if (f.type === "select" && f.options && f.options.length > 0) {
        if (key.leftArrow || key.rightArrow) {
          setError(null);
          const opts = f.options;
          const idx = opts.findIndex((o) => o.value === values[f.name]);
          const delta = key.rightArrow ? 1 : -1;
          const next = opts[(idx + delta + opts.length) % opts.length];
          if (next) setValues((v) => ({ ...v, [f.name]: next.value }));
        }
        return;
      }

      // text / number
      if (key.backspace || key.delete) {
        setError(null);
        setValues((v) => {
          const cur = typeof v[f.name] === "string" ? (v[f.name] as string) : "";
          return { ...v, [f.name]: cur.slice(0, -1) };
        });
        return;
      }

      // Paste: whole clipboard comes in as one chunk. For number
      // fields keep only digits; for text / password allow any
      // printable char. Fixes GitHub-Token / API-key pastes that
      // previously got dropped because isPrintable rejected
      // multi-char inputs.
      if (!key.ctrl && !key.meta && input.length > 1) {
        const clean = sanitizePasteChunk(input, true);
        const filtered =
          f.type === "number" ? clean.split("").filter(isNumericChar).join("") : clean;
        if (filtered.length > 0) {
          setError(null);
          setValues((v) => {
            const cur = typeof v[f.name] === "string" ? (v[f.name] as string) : "";
            return { ...v, [f.name]: cur + filtered };
          });
        }
        return;
      }

      if (isPrintable(input, key)) {
        if (f.type === "number" && !isNumericChar(input)) return;
        // text / number / password all accept printable chars; password
        // masks the render elsewhere.
        setError(null);
        setValues((v) => {
          const cur = typeof v[f.name] === "string" ? (v[f.name] as string) : "";
          return { ...v, [f.name]: cur + input };
        });
      }
    },
    { isActive: !inputDisabled },
  );

  if (fields.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.severity.warning}
        paddingX={1}
      >
        <Text bold>{question}</Text>
        <Text color={theme.severity.dim}>(no fields)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.severity.info} paddingX={1}>
      <Text bold>{question}</Text>
      {fields.map((f, i) => {
        const focused = i === cursor;
        const value = values[f.name];
        return (
          <Box key={f.name} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
            <Text {...(focused ? { color: theme.role.user } : {})}>
              {focused ? "▶ " : "  "}
              {f.label}
              {f.required ? <Text color={theme.severity.error}> *</Text> : null}
            </Text>
            {f.type === "text" || f.type === "number" || f.type === "password" ? (
              <ControlledTextField
                value={
                  typeof value === "string"
                    ? f.type === "password" || f.sensitive
                      ? "•".repeat(value.length)
                      : value
                    : ""
                }
                placeholder={f.placeholder}
                focused={focused && !inputDisabled}
              />
            ) : f.type === "boolean" ? (
              <Text color={theme.severity.dim}>
                {value ? "[✓] yes" : "[ ] no"}
                {focused ? " (space to toggle)" : ""}
              </Text>
            ) : f.type === "select" && f.options ? (
              <Text color={theme.severity.dim}>
                {f.options.map((o) =>
                  o.value === value ? (
                    <Text key={o.value} color={theme.role.user}>
                      [{o.label}]{" "}
                    </Text>
                  ) : (
                    <Text key={o.value}>{o.label} </Text>
                  ),
                )}
                {focused ? "(←/→ to pick)" : ""}
              </Text>
            ) : null}
          </Box>
        );
      })}
      <Text color={theme.severity.dim}>
        Tab/Shift+Tab to navigate · Enter to submit
        {onCancel ? " · Esc to cancel" : ""}
      </Text>
      {error ? <Text color={theme.severity.error}>{error}</Text> : null}
    </Box>
  );
};
