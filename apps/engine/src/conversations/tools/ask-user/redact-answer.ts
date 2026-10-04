import { findSecretSpans } from "../../../logging/scrub-secrets.ts";
import type { FormFieldDefinition } from "./form.ts";

export const ELICITATION_REDACTED_MARKER = "***redacted***";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function formValueContainer(output: Record<string, unknown>): {
  container: Record<string, unknown>;
  wrapped: boolean;
} {
  const wrapped = asRecord(output.values);
  return wrapped ? { container: wrapped, wrapped: true } : { container: output, wrapped: false };
}

function isSecretField(field: FormFieldDefinition): boolean {
  return field?.type === "password" || field?.sensitive === true;
}

function redactSecretSpans(text: string): string {
  const spans = findSecretSpans(text);
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + ELICITATION_REDACTED_MARKER;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

export function redactElicitationOutput(
  toolName: string,
  input: unknown,
  output: unknown,
): unknown {
  const outputObj = asRecord(output);
  if (!outputObj) return output;

  if (toolName === "ask_user_form") {
    const inputObj = asRecord(input);
    const fields =
      inputObj && Array.isArray(inputObj.fields) ? (inputObj.fields as FormFieldDefinition[]) : [];
    const secretNames = new Set(
      fields.filter((f) => f && typeof f.name === "string" && isSecretField(f)).map((f) => f.name),
    );
    if (secretNames.size === 0) return output;
    const clone: Record<string, unknown> = { ...outputObj };
    const { container, wrapped } = formValueContainer(clone);
    const nextContainer: Record<string, unknown> = { ...container };
    for (const name of secretNames) {
      const v = nextContainer[name];
      if (typeof v === "string" && v.length > 0) nextContainer[name] = ELICITATION_REDACTED_MARKER;
    }
    if (wrapped) clone.values = nextContainer;
    else return nextContainer;
    return clone;
  }

  if (toolName === "ask_user_text") {
    const clone: Record<string, unknown> = { ...outputObj };
    if (typeof clone.text === "string") clone.text = redactSecretSpans(clone.text);
    if (typeof clone.value === "string") clone.value = redactSecretSpans(clone.value);
    return clone;
  }

  return output;
}
