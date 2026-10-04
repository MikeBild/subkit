import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { z } from "zod";

export type SchemaFormMode = "form" | "code";

export interface SchemaFormError {
  path: string;
  message: string;
}

export interface SchemaFormProps<T> {
  schema: z.ZodType<T>;
  value: T;
  onChange: (next: T) => void;
  mode: SchemaFormMode;
  onModeChange: (m: SchemaFormMode) => void;
  errors?: SchemaFormError[];
}

export function SchemaForm<T>({
  schema,
  value,
  onChange,
  mode,
  onModeChange,
  errors,
}: SchemaFormProps<T>): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <ModeBar mode={mode} onModeChange={onModeChange} />
      {mode === "form" ? (
        <FormMode schema={schema} value={value} onChange={onChange} errors={errors ?? []} />
      ) : (
        <CodeMode schema={schema} value={value} onChange={onChange} errors={errors ?? []} />
      )}
    </Box>
  );
}

function ModeBar({
  mode,
  onModeChange,
}: {
  mode: SchemaFormMode;
  onModeChange: (m: SchemaFormMode) => void;
}): React.ReactElement {
  const tokens = useTheme();
  useInput((_input, key) => {
    if (key.tab) onModeChange(mode === "form" ? "code" : "form");
  });
  return (
    <Box flexDirection="row">
      <Tab label="form" active={mode === "form"} />
      <Text> </Text>
      <Tab label="code" active={mode === "code"} />
      <Text color={tokens.severity.dim}> · tab toggles mode</Text>
    </Box>
  );
}

function Tab({ label, active }: { label: string; active: boolean }): React.ReactElement {
  const tokens = useTheme();
  return active ? (
    <Text color={tokens.accent.primary} bold>
      [{label}]
    </Text>
  ) : (
    <Text color={tokens.severity.dim}> {label} </Text>
  );
}

interface FieldDescriptor {
  key: string;
  kind: "string" | "number" | "boolean" | "enum" | "unknown";
  options?: readonly string[];
  required: boolean;
}

function describeFields(schema: z.ZodTypeAny): FieldDescriptor[] {
  const def = (schema as { _def?: { type?: string; shape?: Record<string, unknown> } })._def;
  if (def?.type !== "object" || !def.shape) return [];
  const shape = def.shape as Record<string, unknown>;
  const out: FieldDescriptor[] = [];
  for (const [key, raw] of Object.entries(shape)) {
    const inner = raw as {
      _def?: { type?: string; entries?: Record<string, string>; innerType?: unknown };
    };
    const tn = inner._def?.type;
    let kind: FieldDescriptor["kind"] = "unknown";
    let options: readonly string[] | undefined;
    let required = true;
    let nodeForEnum: typeof inner = inner;

    if (tn === "optional") {
      required = false;
      const innerType = (inner._def as { innerType?: { _def?: { type?: string } } } | undefined)
        ?.innerType as { _def?: { type?: string; entries?: Record<string, string> } } | undefined;
      const sub = innerType?._def?.type;
      if (sub === "string") kind = "string";
      else if (sub === "number") kind = "number";
      else if (sub === "boolean") kind = "boolean";
      else if (sub === "enum") {
        kind = "enum";
        if (innerType) nodeForEnum = innerType;
      }
    } else if (tn === "string") kind = "string";
    else if (tn === "number") kind = "number";
    else if (tn === "boolean") kind = "boolean";
    else if (tn === "enum") kind = "enum";

    if (kind === "enum") {
      const entries = nodeForEnum._def?.entries ?? {};
      options = Object.values(entries);
    }
    out.push(options !== undefined ? { key, kind, required, options } : { key, kind, required });
  }
  return out;
}

function FormMode<T>({
  schema,
  value,
  onChange,
  errors,
}: {
  schema: z.ZodType<T>;
  value: T;
  onChange: (next: T) => void;
  errors: SchemaFormError[];
}): React.ReactElement {
  const tokens = useTheme();
  const fields = useMemo(() => describeFields(schema as unknown as z.ZodTypeAny), [schema]);

  const obj = (
    value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  ) as Record<string, unknown>;
  const errorByPath = new Map<string, string>();
  for (const e of errors) errorByPath.set(e.path, e.message);

  if (fields.length === 0) {
    return (
      <Box paddingLeft={2}>
        <Text color={tokens.severity.dim}>
          schema has no top-level fields — switch to code mode
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {fields.map((f) => {
        const v = obj[f.key];
        const err = errorByPath.get(f.key);
        return (
          <Box key={f.key} flexDirection="column">
            <Box flexDirection="row">
              <Text color={tokens.severity.dim}>{f.key}</Text>
              {!f.required ? <Text color={tokens.severity.dim}> (optional)</Text> : null}
              <Text color={tokens.severity.dim}>: </Text>
              <Text color={err ? tokens.severity.error : tokens.emphasis.strong}>
                {formatValue(v, f)}
              </Text>
            </Box>
            {err ? (
              <Box paddingLeft={2}>
                <Text color={tokens.severity.error}>{err}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={tokens.severity.dim}>(form mode is read-only here; code mode for edits)</Text>
      </Box>
      <ChangeForwarder value={value} onChange={onChange} />
    </Box>
  );
}

function ChangeForwarder<T>({
  value,
  onChange,
}: {
  value: T;
  onChange: (next: T) => void;
}): React.ReactElement | null {
  void value;
  void onChange;
  return null;
}

function formatValue(v: unknown, f: FieldDescriptor): string {
  if (v == null) return f.required ? "(missing)" : "(unset)";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function CodeMode<T>({
  value,
  onChange,
  errors,
}: {
  schema: z.ZodType<T>;
  value: T;
  onChange: (next: T) => void;
  errors: SchemaFormError[];
}): React.ReactElement {
  const tokens = useTheme();
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.return && key.shift) {
      setDraft((d) => `${d}\n`);
      return;
    }
    if (key.return) {
      try {
        const parsed = JSON.parse(draft);
        setParseError(null);
        onChange(parsed as T);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((d) => d.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setDraft((d) => d + input);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={tokens.severity.dim}>JSON: </Text>
        <Text color={tokens.emphasis.strong}>{draft}</Text>
      </Box>
      {parseError ? (
        <Box paddingLeft={2}>
          <Text color={tokens.severity.error}>parse error: {parseError}</Text>
        </Box>
      ) : null}
      {errors.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={tokens.severity.dim}>engine validation errors:</Text>
          {errors.map((e, i) => (
            <Box key={`${e.path}-${i}`} paddingLeft={2}>
              <Text color={tokens.severity.error}>
                {e.path}: {e.message}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
      <Box>
        <Text color={tokens.severity.dim}>enter to validate · shift+enter newline</Text>
      </Box>
    </Box>
  );
}

export { describeFields as _describeFieldsForTests };
