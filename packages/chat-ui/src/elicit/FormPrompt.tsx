// askUser.form prompt — vertical stack of typed fields. Tab / Shift+Tab
// navigates between fields; Enter submits. Each field renders via a
// minimal inline input (we reuse @inkjs/ui's TextInput for text /
// number, and a simple toggle for booleans).

import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { useTheme } from "../theme/Provider.tsx";

export interface FormFieldOption {
  value: string;
  label: string;
}

export interface FormField {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  options?: FormFieldOption[] | undefined;
  placeholder?: string | undefined;
  required?: boolean | undefined;
}

export interface FormPromptProps {
  question: string;
  fields: FormField[];
  onResponse: (value: { values: Record<string, unknown> }) => void;
  inputDisabled?: boolean | undefined;
}

export const FormPrompt: React.FC<FormPromptProps> = ({
  question,
  fields,
  onResponse,
  inputDisabled,
}) => {
  const theme = useTheme();
  const [cursor, setCursor] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.type === "boolean") initial[f.name] = false;
      else if (f.type === "select" && f.options && f.options.length > 0)
        initial[f.name] = f.options[0]?.value;
      else initial[f.name] = "";
    }
    return initial;
  });

  useInput(
    (_input, key) => {
      if (fields.length === 0) return;
      if (key.tab && key.shift) setCursor((i) => (i - 1 + fields.length) % fields.length);
      else if (key.tab) setCursor((i) => (i + 1) % fields.length);
      else if (key.return && cursor === fields.length - 1) {
        const missingRequired = fields.find(
          (f) =>
            f.required &&
            (values[f.name] === undefined || values[f.name] === null || values[f.name] === ""),
        );
        if (!missingRequired) onResponse({ values });
      } else if (cursor < fields.length) {
        const f = fields[cursor];
        if (f?.type === "boolean" && _input === " ") {
          setValues((v) => ({ ...v, [f.name]: !v[f.name] }));
        } else if (f?.type === "select" && f.options && f.options.length > 0) {
          if (key.leftArrow || key.rightArrow) {
            const idx = f.options.findIndex((o) => o.value === values[f.name]);
            const delta = key.rightArrow ? 1 : -1;
            const next = f.options[(idx + delta + f.options.length) % f.options.length];
            if (next) setValues((v) => ({ ...v, [f.name]: next.value }));
          }
        }
      }
    },
    { isActive: !inputDisabled },
  );

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
            {f.type === "text" || f.type === "number" ? (
              focused && !inputDisabled ? (
                <TextInput
                  placeholder={f.placeholder ?? ""}
                  onChange={(v) =>
                    setValues((prev) => ({
                      ...prev,
                      [f.name]: f.type === "number" ? Number(v) : v,
                    }))
                  }
                />
              ) : (
                <Text color={theme.severity.dim}>
                  {value === "" || value === undefined ? (f.placeholder ?? "") : String(value)}
                </Text>
              )
            ) : f.type === "boolean" ? (
              <Text color={theme.severity.dim}>
                {value ? "[✓] yes" : "[ ] no"} {focused ? "(space to toggle)" : ""}
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
      <Text color={theme.severity.dim}>Tab to advance · Enter on last field to submit</Text>
    </Box>
  );
};
