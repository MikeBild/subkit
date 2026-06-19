import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { resolveAction } from "../keybindings/useKeybinding.ts";
import { labelForPath } from "../lib/config-labels.ts";
import type { FormField } from "../lib/zod-to-form-fields.ts";

interface Props {
  field: FormField;
  onCommit: (field: FormField, value: unknown) => void | Promise<void>;
  onCancel: () => void;
}

function initialBuffer(field: FormField): string {
  if (field.sensitive) return "";
  if (field.value === undefined || field.value === null) return "";
  if (typeof field.value === "string") return field.value;
  return JSON.stringify(field.value);
}

function parseValue(
  field: FormField,
  raw: string,
): { ok: true; value: unknown } | { ok: false; err: string } {
  if (field.kind === "text" || field.kind === "secret") {
    return { ok: true, value: raw };
  }
  if (field.kind === "number") {
    if (raw.trim() === "") return { ok: false, err: "expected a number" };
    const n = Number(raw);
    if (Number.isNaN(n)) return { ok: false, err: `not a number: ${raw}` };
    return { ok: true, value: n };
  }
  if (field.kind === "bool") {
    const v = raw.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(v)) return { ok: true, value: true };
    if (["false", "0", "no", "n", "off", ""].includes(v)) return { ok: true, value: false };
    return { ok: false, err: `expected true/false; got ${raw}` };
  }
  if (field.kind === "select") {
    return { ok: true, value: raw.trim() };
  }
  if (field.kind === "string-list") {
    const items = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { ok: true, value: items };
  }
  // json
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

export const FieldEditor: React.FC<Props> = ({ field, onCommit, onCancel }) => {
  const [buffer, setBuffer] = useState<string>(initialBuffer(field));
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useInput(async (input, key) => {
    if (submitting) return;
    const action = resolveAction("Field", input, key);
    if (action === "field:cancel") {
      onCancel();
      return;
    }
    if (action === "field:reveal-secret") {
      if (field.kind === "secret") setReveal((v) => !v);
      return;
    }
    if (action === "field:commit") {
      const parsed = parseValue(field, buffer);
      if (!parsed.ok) {
        setError(parsed.err);
        return;
      }
      setSubmitting(true);
      try {
        await onCommit(field, parsed.value);
      } finally {
        setSubmitting(false);
      }
      return;
    }
    // Backspace + printable characters are not bound to a registry
    // action — they are buffer ops on the in-flight edit. Keeping
    // them inline preserves the operator's typing experience without
    // expanding the registry surface to per-key string handlers.
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      setError(null);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setBuffer((b) => b + input);
      setError(null);
    }
  });

  const display =
    field.kind === "secret" && !reveal && buffer.length > 0 ? "•".repeat(buffer.length) : buffer;
  const label = labelForPath(field.path);
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{label}</Text>
        <Text color="gray">
          {"  ·  "}
          {field.path} ({field.kind})
        </Text>
      </Box>
      {field.description ? <Text color="gray">{field.description}</Text> : null}
      <Box marginTop={1}>
        <Text color="gray">▸ </Text>
        <Text>{display}</Text>
        <Text inverse> </Text>
      </Box>
      {field.kind === "select" && field.enumValues ? (
        <Text color="gray">choices: {field.enumValues.join(" | ")}</Text>
      ) : null}
      {error ? (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      ) : null}
      {submitting ? (
        <Box marginTop={1}>
          <Text color="yellow">submitting…</Text>
        </Box>
      ) : null}
    </Box>
  );
};
