// D7 — secret-shaped elicitation detection.
//
// Decides whether an `ask_user_*` payload would collect a raw secret
// (API key / token / password / credential) from the operator. The
// enforcement point (`pauseForUserInput`, gated on `surface === "mcp"`)
// uses this to refuse a chat elicitation and route the operator to the
// secure flow (portal-setup URL / OAuth) instead — the reference
// integration-authoring architecture NEVER asks for a secret in chat.
//
// Detection reuses the dual-contract redaction primitives so there is
// ONE definition of "secret-shaped" across logs, prose scrubbing, and
// this gate:
//   - `SENSITIVE_KEY_PATTERN` — the same predicate `isSensitiveKey`
//     applies to structured key names (token/secret/password/api_key/
//     credential/authorization). Applied here to form-field names/labels
//     and to a free-text question.
//   - `findSecretSpans` (backed by `SECRET_PATTERNS`) — catches a
//     concrete secret VALUE that already leaked into a placeholder or
//     default (a vendor-prefixed PAT, a JWT, a high-entropy token).
//
// Only `ask_user_form` and `ask_user_text` are credential-entry vectors:
// `ask_user_choice` / `ask_user_multi` collect an enumerated selection
// and `ask_user_confirm` collects a boolean, none of which can carry a
// pasted secret, so they are never flagged.

import { findSecretSpans, SENSITIVE_KEY_PATTERN } from "../../../logging/scrub-secrets.ts";
import type { FormFieldDefinition } from "./form.ts";

export type SecretElicitationReason =
  /** `ask_user_form` field declared `type: "password"`. */
  | "password_field"
  /** `ask_user_form` field flagged `sensitive: true`. */
  | "sensitive_flag"
  /** `ask_user_form` field whose name or label reads as a secret. */
  | "secret_field_name"
  /** `ask_user_text` question that reads as a request for a secret. */
  | "secret_question"
  /** A concrete secret value already sits in a placeholder / default. */
  | "secret_literal";

export interface SecretElicitationHit {
  reason: SecretElicitationReason;
  /** Offending form-field name, or `"question"` for `ask_user_text`. */
  field: string;
}

/**
 * True when `SENSITIVE_KEY_PATTERN` matches `s`. The canonical predicate
 * targets structured KEY names (`api_key`), so it also runs against a
 * whitespace-collapsed copy (`api key` → `api_key`) — this catches prose
 * labels/questions ("your API key") without inventing a second keyword
 * list. The pattern carries no `g` flag, so `.test` has no lastIndex
 * hazard.
 */
function readsSensitive(s: unknown): boolean {
  if (typeof s !== "string") return false;
  return SENSITIVE_KEY_PATTERN.test(s) || SENSITIVE_KEY_PATTERN.test(s.replace(/\s+/g, "_"));
}

/** True when a concrete secret value is already embedded in `s`. */
function carriesSecretLiteral(s: unknown): boolean {
  return typeof s === "string" && s.length > 0 && findSecretSpans(s).length > 0;
}

/**
 * Would this `ask_user_*` payload elicit a raw secret from the operator?
 * Returns the first matching signal, or `null` when the payload collects
 * no secret-shaped input.
 */
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
