import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

export interface AdminFormField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
}

interface Props {
  title: string;
  fields: readonly AdminFormField[];
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onCancel: () => void;
}

export const AdminCreateForm: React.FC<Props> = ({ title, fields, onSubmit, onCancel }) => {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, ""])),
  );
  const [idx, setIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = fields[idx];

  useInput((input, key) => {
    if (submitting) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(fields.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const missing = fields.find((f) => f.required && !values[f.key]?.trim());
      if (missing) {
        setError(`${missing.label} is required`);
        setIdx(fields.findIndex((f) => f.key === missing.key));
        return;
      }
      setError(null);
      setSubmitting(true);
      onSubmit(values)
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setSubmitting(false));
      return;
    }
    if (!active) return;
    if (key.backspace || key.delete) {
      setValues((v) => ({ ...v, [active.key]: (v[active.key] ?? "").slice(0, -1) }));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValues((v) => ({ ...v, [active.key]: (v[active.key] ?? "") + input }));
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      <Text color="gray">
        ↑/↓ to switch fields · type to edit · Enter to submit · Esc to cancel
      </Text>
      <Box marginTop={1} flexDirection="column">
        {fields.map((f, i) => (
          <Box key={f.key}>
            <Box width={20}>
              <Text color={i === idx ? "cyan" : "gray"} bold={i === idx}>
                {i === idx ? "› " : "  "}
                {f.label}
                {f.required ? "*" : ""}
              </Text>
            </Box>
            <Text>{values[f.key] ?? ""}</Text>
            {i === idx && !submitting ? <Text inverse> </Text> : null}
            {!values[f.key] && f.placeholder ? <Text color="gray"> ({f.placeholder})</Text> : null}
          </Box>
        ))}
      </Box>
      {submitting ? (
        <Box marginTop={1}>
          <Text color="gray">submitting…</Text>
        </Box>
      ) : null}
      {error ? (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
