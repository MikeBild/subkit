import type { PendingElicitation } from "@cli-core/index.ts";
import { describeConfirmationPayload } from "../repl/approval/describe-confirmation.ts";

export const PENDING_NOTICE_PREFIX = "Waiting for input:";

const SENSITIVE_FIELD_NAME_RE =
  /(?:^|_)(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|client[-_]?secret|auth)(?:$|_)/i;

interface FormFieldMeta {
  name: string;
  type?: string;
  sensitive?: boolean;
  label?: string;
}

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

export function renderElicitAnswer(output: unknown, input?: unknown, reason?: string): string {
  const suffix = reason ? ` — ${reason}` : "";
  if (output === null || output === undefined) return `(no answer)${suffix}`;
  if (typeof output === "string") return `${output}${suffix}`;
  if (typeof output === "number" || typeof output === "boolean") {
    return `${String(output)}${suffix}`;
  }
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    const payloadPreview = describeConfirmationPayload(input);
    const previewSuffix = payloadPreview ? ` · ${payloadPreview}` : "";
    if (obj.confirmed === true) return `approve${previewSuffix}${suffix}`;
    if (obj.confirmed === false || obj.declined === true) return `reject${previewSuffix}${suffix}`;
    if (obj.tested === true) return `test${previewSuffix}${suffix}`;
    if (obj.partial === true) return `partial${previewSuffix}${suffix}`;
    if (typeof obj.value === "string") return `${obj.value}${suffix}`;
    if (typeof obj.choice === "string") return `${obj.choice}${suffix}`;
    if (Array.isArray(obj.choices)) return `${(obj.choices as unknown[]).join(", ")}${suffix}`;

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
        parts.push(`${k}=***`);
      } else if (typeof v === "string") {
        parts.push(`${k}=${truncateForTranscript(v)}`);
      } else if (typeof v === "number" || typeof v === "boolean") {
        parts.push(`${k}=${v}`);
      }
      if (parts.length >= 3) break;
    }
    if (parts.length > 0) return `${parts.join(", ")}${suffix}`;

    if (schema.size > 0) {
      const names = [...schema.keys()].slice(0, 3).join(", ");
      return `(filled: ${names})${suffix}`;
    }
  }
  return `(answered)${suffix}`;
}

export function pendingNoticeMessage(elicitation: PendingElicitation): string | null {
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
