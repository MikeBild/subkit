// Elicitation → transcript rendering helpers.
//
// Owns the audit-line rendering for resolved elicitations
// (`renderElicitAnswer`) — including the sensitive-field redaction
// that keeps credentials out of the scrollback — and the fallback
// "Waiting for input" notice for elicitations without a typed prompt
// component.

import type { PendingElicitation } from "@cli-core/index.ts";

import { describeConfirmationPayload } from "../repl/approval/describe-confirmation.ts";

export const PENDING_NOTICE_PREFIX = "Waiting for input:";

// Field names whose values must be redacted in the transcript even
// when the form schema does not mark them sensitive. Defense in depth
// for malformed `ask_user_form` calls — a renderer that lazily passes
// the secret through is the worst possible failure mode.
const SENSITIVE_FIELD_NAME_RE =
  /(?:^|_)(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|client[-_]?secret|auth)(?:$|_)/i;

interface FormFieldMeta {
  name: string;
  type?: string;
  sensitive?: boolean;
  label?: string;
}

/** Pull the form's field schema out of `PendingElicitation.input`,
 *  if any. Returns a Map keyed by field name → metadata. */
function readFormFieldSchema(input: unknown): Map<string, FormFieldMeta> {
  const out = new Map<string, FormFieldMeta>();
  if (!input || typeof input !== "object") return out;
  const fields = (input as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return out;
  for (const f of fields) {
    if (!f || typeof f !== "object") continue;
    const obj = f as Record<string, unknown>;
    if (typeof obj.name !== "string") continue;
    out.set(obj.name, {
      name: obj.name,
      ...(typeof obj.type === "string" ? { type: obj.type } : {}),
      ...(typeof obj.sensitive === "boolean" ? { sensitive: obj.sensitive } : {}),
      ...(typeof obj.label === "string" ? { label: obj.label } : {}),
    });
  }
  return out;
}

function isSensitiveField(name: string, meta: FormFieldMeta | undefined): boolean {
  if (meta?.sensitive === true) return true;
  if (meta?.type === "password") return true;
  return SENSITIVE_FIELD_NAME_RE.test(name);
}

function truncateForTranscript(value: string): string {
  return value.length > 40 ? `${value.slice(0, 37)}…` : value;
}

// Render an elicitation's `output` payload as a short, human-readable
// string for the transcript. Keeps the assistant turn auditable —
// without this the scrollback silently mutates ("approve" disappears
// from the record after the next LLM response). Sensitive form fields
// (type=password, sensitive:true, or a name like `token`/`api_key`)
// render as `<name>=***` so the audit trail names what was provided
// without leaking the secret.
export function renderElicitAnswer(output: unknown, input?: unknown, reason?: string): string {
  const suffix = reason ? ` — ${reason}` : "";
  if (output === null || output === undefined) return `(no answer)${suffix}`;
  if (typeof output === "string") return `${output}${suffix}`;
  if (typeof output === "number" || typeof output === "boolean") {
    return `${String(output)}${suffix}`;
  }
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    // For confirmations, append a short payload preview so the
    // transcript captures WHAT was approved, not just the verb. Pulled
    // from `commit_intent.description` first (the LLM's own one-line
    // summary), then `target.tool` + workflow/connector identifier as
    // a fallback. Without this, scrolling back through 5 "approve"
    // lines is meaningless — exactly the audit gap the operator hit
    // in session a6440493.
    const payloadPreview = describeConfirmationPayload(input);
    const previewSuffix = payloadPreview ? ` · ${payloadPreview}` : "";
    if (obj.confirmed === true) return `approve${previewSuffix}${suffix}`;
    if (obj.confirmed === false || obj.declined === true) return `reject${previewSuffix}${suffix}`;
    if (obj.tested === true) return `test${previewSuffix}${suffix}`;
    if (obj.partial === true) return `partial${previewSuffix}${suffix}`;
    if (typeof obj.value === "string") return `${obj.value}${suffix}`;
    if (typeof obj.choice === "string") return `${obj.choice}${suffix}`;
    if (Array.isArray(obj.choices)) return `${(obj.choices as unknown[]).join(", ")}${suffix}`;

    // Form output — render each field, redacting sensitive ones based
    // on the input schema (and a defensive name heuristic). Form
    // submissions arrive shaped as either `{values: {...}}` or `{...}`
    // depending on the engine path; handle both.
    const values =
      typeof obj.values === "object" && obj.values !== null
        ? (obj.values as Record<string, unknown>)
        : obj;
    const schema = readFormFieldSchema(input);
    const parts: string[] = [];
    for (const [k, v] of Object.entries(values)) {
      const meta = schema.get(k);
      const sensitive = isSensitiveField(k, meta);
      if (sensitive) {
        // Render the field name (and "***") even when the value is
        // missing — this signals "credential collected" without
        // exposing the secret.
        parts.push(`${k}=***`);
      } else if (typeof v === "string") {
        parts.push(`${k}=${truncateForTranscript(v)}`);
      } else if (typeof v === "number" || typeof v === "boolean") {
        parts.push(`${k}=${v}`);
      }
      if (parts.length >= 3) break;
    }
    if (parts.length > 0) return `${parts.join(", ")}${suffix}`;

    // Output empty / opaque, but the schema names fields — say what
    // the user filled (by name) so the audit is not just "(answered)".
    if (schema.size > 0) {
      const names = [...schema.keys()].slice(0, 3).join(", ");
      return `(filled: ${names})${suffix}`;
    }
  }
  return `(answered)${suffix}`;
}

export function pendingNoticeMessage(elicitation: PendingElicitation): string | null {
  // All ask_user_* elicitations have a dedicated typed prompt component
  // (ConfirmPrompt, ChoicePrompt, MultiChoicePrompt, FormPrompt,
  // TextPrompt) that renders the full question + summary + options
  // below. Adding a top-of-screen "Waiting for input" banner here too
  // produces a back-to-back duplicate render — the user sees the same
  // prose twice in two differently-styled boxes (G12 in the runtime-
  // logs review plan; reproduced in screenshot of OAuth approval).
  //
  // The banner exists only as a fallback for elicitations whose tool
  // name the CLI does not recognise — those have no typed prompt and
  // would otherwise pause the loop silently. For everything we know
  // how to render, the typed prompt is the single source of truth.
  switch (elicitation.tool_name) {
    case "ask_user_form":
    case "ask_user_confirm":
    case "ask_user_choice":
    case "ask_user_multi":
    case "ask_user_text":
      return null;
    default:
      return `${PENDING_NOTICE_PREFIX} ${elicitation.summary.trim()}.`;
  }
}
