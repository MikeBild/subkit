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
//                      For `json` fields with content, Enter inserts a
//                      newline (use Ctrl-D to commit a JSON buffer
//                      without leaving focus, or Tab off the field).
//   Esc              — onCancel if provided.
//   Backspace/Delete — pop last char from focused text/number/password/json field.
//   Space            — toggle focused boolean / `multi` option; literal space in text.
//   ← / →            — cycle options on focused select field.
//   ↑ / ↓            — move focused row inside `multi` checkbox grid.
//   Ctrl-D           — confirm a `json` buffer (parse + clear inline error).
//   Printable char   — append to focused text/number/password/json field
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
  /**
   * Field render mode. `text/number/boolean/select` are the original
   * four; `password` masks input (single-line); `json` accepts a
   * multi-line buffer parsed on blur; `multi` is a checkbox grid that
   * yields a `string[]` subset of `options`.
   */
  type: "text" | "number" | "boolean" | "select" | "password" | "json" | "multi";
  /**
   * `select` expects `Array<{value,label}>`. `multi` expects
   * `string[]`. The renderer normalizes both.
   */
  options?: FormFieldOption[] | string[] | undefined;
  placeholder?: string | undefined;
  required?: boolean | undefined;
  /**
   * When true, the rendered value is masked (bullet characters). `password`
   * fields imply `sensitive: true`. Used by the credential-collection
   * flow so typed secrets never appear on the terminal.
   */
  sensitive?: boolean | undefined;
  /**
   * Optional error pin shown beneath the field (e.g. "invalid JSON: …").
   * Server populates this when it re-prompts; the renderer may also
   * set it locally for immediate feedback.
   */
  error_message?: string | undefined;
}

export interface FormPromptProps {
  question: string;
  fields: FormField[];
  onResponse: (value: { values: Record<string, unknown> }) => void;
  onCancel?: (() => void) | undefined;
  inputDisabled?: boolean | undefined;
}

type FieldValues = Record<string, unknown>;

function multiOptions(field: FormField): string[] {
  if (!Array.isArray(field.options)) return [];
  return field.options
    .map((o) => (typeof o === "string" ? o : typeof o === "object" && o ? o.value : null))
    .filter((s): s is string => s !== null);
}

function selectOptions(field: FormField): FormFieldOption[] {
  if (!Array.isArray(field.options)) return [];
  return field.options
    .map((o) => {
      if (typeof o === "string") return { value: o, label: o };
      if (typeof o === "object" && o) return o;
      return null;
    })
    .filter((o): o is FormFieldOption => o !== null);
}

function initialValues(fields: FormField[]): FieldValues {
  const initial: FieldValues = {};
  for (const f of fields) {
    if (f.type === "boolean") initial[f.name] = false;
    else if (f.type === "select") {
      const opts = selectOptions(f);
      initial[f.name] = opts[0]?.value ?? "";
    } else if (f.type === "multi") initial[f.name] = [] as string[];
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
 * (json) keep newlines.
 */
// Built via `new RegExp` with a unicode escape so the source file
// doesn't embed a literal ESC (0x1b) byte that lint flags as a control
// char in regex-literal syntax.
// biome-ignore lint/suspicious/noControlCharactersInRegex: literal ESC byte is exactly what we strip — RegExp(...) constructor triggers the opposite "prefer literal" rule.
const BRACKETED_PASTE_RE = /\[20[01]~/g;

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

function tryParseJson(value: string): { ok: true } | { ok: false; message: string } {
  if (value.trim() === "") return { ok: true };
  try {
    JSON.parse(value);
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "parse error";
    return { ok: false, message: `invalid JSON: ${reason}` };
  }
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
      if (Array.isArray(v) && v.length === 0) return i;
      if (f.type === "number" && typeof v === "string") {
        const n = Number(v);
        if (!Number.isFinite(n)) return i;
      }
    }
    if (f.type === "json" && typeof v === "string") {
      const parsed = tryParseJson(v);
      if (!parsed.ok) return i;
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
  // Per-field local error pin (currently driven by the json parser).
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  // Inner cursor for `multi` rows — which option is currently focused
  // inside the focused multi field.
  const [multiRow, setMultiRow] = useState<Record<string, number>>({});

  const setFieldError = (name: string, msg: string | null): void => {
    setFieldErrors((prev) => ({ ...prev, [name]: msg }));
  };

  useInput(
    (input, key) => {
      if (fields.length === 0) return;

      if (key.escape) {
        onCancel?.();
        return;
      }

      const f = fields[cursor];

      // Tab navigation; before leaving a `json` field we re-validate
      // so the operator sees the parse error pin without needing
      // Ctrl-D first.
      if (key.tab) {
        setError(null);
        if (f && f.type === "json") {
          const buf = typeof values[f.name] === "string" ? (values[f.name] as string) : "";
          const parsed = tryParseJson(buf);
          setFieldError(f.name, parsed.ok ? null : parsed.message);
        }
        setCursor((i) => {
          const n = fields.length;
          return key.shift ? (i - 1 + n) % n : (i + 1) % n;
        });
        return;
      }

      // Ctrl-D commits a json buffer (parse-only — does NOT submit
      // the whole form). The operator stays on the field if invalid.
      if (f?.type === "json" && key.ctrl && (input === "d" || input === "\x04")) {
        const buf = typeof values[f.name] === "string" ? (values[f.name] as string) : "";
        const parsed = tryParseJson(buf);
        setFieldError(f.name, parsed.ok ? null : parsed.message);
        return;
      }

      if (key.return) {
        // For json fields with non-empty content, Enter inserts a
        // newline rather than submitting — so the operator can write
        // multi-line JSON without prematurely committing.
        if (f && f.type === "json") {
          setError(null);
          setValues((v) => {
            const cur = typeof v[f.name] === "string" ? (v[f.name] as string) : "";
            return { ...v, [f.name]: `${cur}\n` };
          });
          setFieldError(f.name, null);
          return;
        }
        const idx = firstInvalidIndex(fields, values);
        if (idx >= 0) {
          const failing = fields[idx];
          if (failing && failing.type === "json") {
            const buf =
              typeof values[failing.name] === "string" ? (values[failing.name] as string) : "";
            const parsed = tryParseJson(buf);
            if (!parsed.ok) setFieldError(failing.name, parsed.message);
          }
          setError(`Please fill the required field above.`);
          setCursor(idx);
          return;
        }
        onResponse({ values: coerce(fields, values) });
        return;
      }

      if (!f) return;

      if (f.type === "boolean") {
        if (input === " ") {
          setError(null);
          setValues((v) => ({ ...v, [f.name]: !v[f.name] }));
        }
        return;
      }

      if (f.type === "select") {
        const opts = selectOptions(f);
        if (opts.length > 0 && (key.leftArrow || key.rightArrow)) {
          setError(null);
          const idx = opts.findIndex((o) => o.value === values[f.name]);
          const delta = key.rightArrow ? 1 : -1;
          const next = opts[(idx + delta + opts.length) % opts.length];
          if (next) setValues((v) => ({ ...v, [f.name]: next.value }));
        }
        return;
      }

      if (f.type === "multi") {
        const opts = multiOptions(f);
        if (opts.length === 0) return;
        const row = multiRow[f.name] ?? 0;
        if (key.upArrow) {
          setMultiRow((m) => ({ ...m, [f.name]: (row - 1 + opts.length) % opts.length }));
          return;
        }
        if (key.downArrow) {
          setMultiRow((m) => ({ ...m, [f.name]: (row + 1) % opts.length }));
          return;
        }
        if (input === " ") {
          setError(null);
          const target = opts[row];
          if (!target) return;
          setValues((v) => {
            const cur = Array.isArray(v[f.name]) ? (v[f.name] as string[]) : [];
            const next = cur.includes(target) ? cur.filter((x) => x !== target) : [...cur, target];
            return { ...v, [f.name]: next };
          });
        }
        return;
      }

      // text / number / password / json
      if (key.backspace || key.delete) {
        setError(null);
        setValues((v) => {
          const cur = typeof v[f.name] === "string" ? (v[f.name] as string) : "";
          return { ...v, [f.name]: cur.slice(0, -1) };
        });
        if (f.type === "json") setFieldError(f.name, null);
        return;
      }

      // Paste: whole clipboard comes in as one chunk. For number
      // fields keep only digits; for text / password allow any
      // printable char. Json fields preserve newlines so a pasted
      // multi-line JSON document survives intact.
      if (!key.ctrl && !key.meta && input.length > 1) {
        const isJson = f.type === "json";
        const clean = sanitizePasteChunk(input, !isJson);
        const filtered =
          f.type === "number" ? clean.split("").filter(isNumericChar).join("") : clean;
        if (filtered.length > 0) {
          setError(null);
          setValues((v) => {
            const cur = typeof v[f.name] === "string" ? (v[f.name] as string) : "";
            return { ...v, [f.name]: cur + filtered };
          });
          if (isJson) setFieldError(f.name, null);
        }
        return;
      }

      if (isPrintable(input, key)) {
        if (f.type === "number" && !isNumericChar(input)) return;
        // password rejects newlines server-side; the renderer never
        // gets one through `isPrintable` anyway, but be explicit.
        if (f.type === "password" && (input === "\n" || input === "\r")) return;
        setError(null);
        setValues((v) => {
          const cur = typeof v[f.name] === "string" ? (v[f.name] as string) : "";
          return { ...v, [f.name]: cur + input };
        });
        if (f.type === "json") setFieldError(f.name, null);
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
        const fieldError = fieldErrors[f.name] ?? f.error_message ?? null;
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
            ) : f.type === "select" ? (
              <Text color={theme.severity.dim}>
                {selectOptions(f).map((o) =>
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
            ) : f.type === "multi" ? (
              <Box flexDirection="column">
                {multiOptions(f).map((opt, optIdx) => {
                  const selected = Array.isArray(value) && (value as string[]).includes(opt);
                  const rowFocused = focused && (multiRow[f.name] ?? 0) === optIdx;
                  return (
                    <Text
                      key={opt}
                      {...(rowFocused ? { color: theme.role.user } : { color: theme.severity.dim })}
                    >
                      {rowFocused ? "▶ " : "  "}
                      {selected ? "[x] " : "[ ] "}
                      {opt}
                    </Text>
                  );
                })}
                {focused ? (
                  <Text color={theme.severity.dim}>
                    ↑/↓ to move · space to toggle · Tab/Enter when done
                  </Text>
                ) : null}
              </Box>
            ) : f.type === "json" ? (
              <Box flexDirection="column">
                {(() => {
                  const buf = typeof value === "string" ? value : "";
                  const lines = buf.length === 0 ? [""] : buf.split("\n");
                  return lines.map((line, lineIdx) => {
                    const isLast = lineIdx === lines.length - 1;
                    if (focused && !inputDisabled && isLast) {
                      return (
                        <Text key={`json-${lineIdx}`}>
                          {line}
                          <Text inverse> </Text>
                        </Text>
                      );
                    }
                    if (line === "" && !focused && lineIdx === 0 && f.placeholder) {
                      return (
                        <Text key={`json-${lineIdx}`} color={theme.severity.dim}>
                          {f.placeholder}
                        </Text>
                      );
                    }
                    return <Text key={`json-${lineIdx}`}>{line}</Text>;
                  });
                })()}
                {focused ? (
                  <Text color={theme.severity.dim}>
                    Enter for newline · Ctrl-D to validate · Tab to leave field
                  </Text>
                ) : null}
              </Box>
            ) : null}
            {fieldError ? <Text color={theme.severity.error}>{fieldError}</Text> : null}
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
