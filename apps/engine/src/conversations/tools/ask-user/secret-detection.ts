import { findSecretSpans, SENSITIVE_KEY_PATTERN } from "../../../logging/scrub-secrets.ts";
import type { FormFieldDefinition } from "./form.ts";

export type SecretElicitationReason =
  | "password_field"
  | "sensitive_flag"
  | "secret_field_name"
  | "secret_question"
  | "secret_literal";

export interface SecretElicitationHit {
  reason: SecretElicitationReason;
  field: string;
}

function readsSensitive(s: unknown): boolean {
  if (typeof s !== "string") return false;
  return SENSITIVE_KEY_PATTERN.test(s) || SENSITIVE_KEY_PATTERN.test(s.replace(/\s+/g, "_"));
}

function carriesSecretLiteral(s: unknown): boolean {
  return typeof s === "string" && s.length > 0 && findSecretSpans(s).length > 0;
}

export function detectSecretElicitation(
  toolName: string,
  input: unknown,
): SecretElicitationHit | null {
  if (input == null || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  if (toolName === "ask_user_form") {
    const fields = Array.isArray(obj.fields) ? (obj.fields as FormFieldDefinition[]) : [];
    for (const f of fields) {
      if (f == null || typeof f !== "object") continue;
      const name = typeof f.name === "string" ? f.name : "";
      if (f.type === "password") return { reason: "password_field", field: name };
      if (f.sensitive === true) return { reason: "sensitive_flag", field: name };
      if (readsSensitive(f.name) || readsSensitive(f.label)) {
        return { reason: "secret_field_name", field: name };
      }
      if (carriesSecretLiteral(f.placeholder)) {
        return { reason: "secret_literal", field: name };
      }
    }
    return null;
  }

  if (toolName === "ask_user_text") {
    if (readsSensitive(obj.question)) return { reason: "secret_question", field: "question" };
    if (carriesSecretLiteral(obj.placeholder) || carriesSecretLiteral(obj.default)) {
      return { reason: "secret_literal", field: "question" };
    }
    return null;
  }

  return null;
}
