// Field-metadata-driven redaction of an elicitation ANSWER before it is
// persisted to `conversation_elicitations.output` and replayed into LLM
// context (#304).
//
// The engine already BLOCKS secret-shaped elicitations over MCP and
// degrades password fields to URL/portal — but the sanctioned CLI/web
// masked-form path still lets an operator type a real secret. Its
// masked value must not survive at rest or re-enter the model's context.
// The raw answer still flows through the in-memory outcome pipeline
// (credential cache / auto-persist) — callers keep the raw `output` and
// persist ONLY this projection.
//
// Driven by the elicitation's own `input` (the ask_user_* definition):
// a form field declares `type:"password"` / `sensitive:true`, so we know
// exactly which answer values are secret without guessing from key names
// or value entropy. Non-secret fields pass through byte-identical, so a
// redacted output still validates + replays like the original.

import { findSecretSpans } from "../../../logging/scrub-secrets.ts";
import type { FormFieldDefinition } from "./form.ts";

// Reuse the shared marker (idempotent — `isAlreadyRedacted` in
// packages/shared/src/redaction.ts recognizes it, so re-redacting is a
// no-op).
export const ELICITATION_REDACTED_MARKER = "***redacted***";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** The answered value map for ask_user_form: the DB-pause portal sends
 *  `{ values: {...} }`, the MCP bridge resolves the flat map. Mirrors
 *  `validate-answer.ts#formValues` so the same lookup path is redacted. */
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

/** Replace every `findSecretSpans` hit in `text` with the marker. Pattern-
 *  based, so ordinary prose (and a low-entropy password with no vendor
 *  prefix) is left intact — the form-field metadata path is what catches
 *  masked secrets; this only defends the free-text tool against pasted
 *  vendor tokens. */
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

/**
 * Return a redacted PROJECTION of an elicitation answer for persistence.
 * The raw value must not flow here — pass a copy; callers keep the raw
 * `output` for the in-memory outcome pipeline.
 *
 * - `ask_user_form`: each `type:"password"`/`sensitive:true` field's
 *   answer value becomes the marker; other fields byte-identical.
 * - `ask_user_text`: secret spans in the answer string are masked.
 * - everything else (choice/multi/confirm, declines, null): passthrough.
 */
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
    // Shallow clone at each level we touch — never mutate the caller's raw
    // object (it is still in use by the outcome pipeline).
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
    // Portal sends `{ text }`; the MCP bridge maps to `{ value }`.
    const clone: Record<string, unknown> = { ...outputObj };
    if (typeof clone.text === "string") clone.text = redactSecretSpans(clone.text);
    if (typeof clone.value === "string") clone.value = redactSecretSpans(clone.value);
    return clone;
  }

  return output;
}
