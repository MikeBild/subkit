import type { ConversationDetail } from "@/api/client";
import type { CatalogLabel } from "@/lib/machine-label";

type Pending = NonNullable<NonNullable<ConversationDetail["resume_summary"]>["pending_approval"]>;
export type ChatFormField = NonNullable<NonNullable<Pending["prompt"]>["fields"]>[number];
export interface ChatForm {
  id: string;
  toolCallId: string;
  question: string;
  fields: ChatFormField[];
  expiresAt: string;
  intentKind?: string;
}
export function chatForm(detail: ConversationDetail | undefined): ChatForm | null {
  const pending = detail?.resume_summary?.pending_approval;
  if (
    pending?.tool_name !== "ask_user_form" ||
    !pending.tool_call_id ||
    !pending.prompt?.fields?.length
  )
    return null;
  if (!detail?.tool_calls.some((call) => call.id === pending.tool_call_id)) return null;
  return {
    id: pending.id,
    toolCallId: pending.tool_call_id,
    question: pending.prompt.question,
    fields: pending.prompt.fields,
    expiresAt: pending.expires_at,
    ...(pending.prompt.intent_kind ? { intentKind: pending.prompt.intent_kind } : {}),
  };
}

export function isSecretField(field: Pick<ChatFormField, "type" | "sensitive">): boolean {
  return field.type === "password" || field.sensitive === true;
}

export type FormInputKind =
  | "checkbox"
  | "select"
  | "multi"
  | "textarea"
  | "number"
  | "secret"
  | "text";

export function formInputKind(field: Pick<ChatFormField, "type" | "sensitive">): FormInputKind {
  switch (field.type) {
    case "boolean":
      return "checkbox";
    case "select":
      return "select";
    case "multi":
      return "multi";
    case "password":
      return "secret";
    case "json":
      return field.sensitive ? "secret" : "textarea";
    case "number":
      return field.sensitive ? "secret" : "number";
    case "text":
      return field.sensitive ? "secret" : "text";
    default: {
      const unhandled: never = field.type;
      return unhandled;
    }
  }
}

export function initialFieldValue(field: ChatFormField): string | boolean | string[] {
  if (field.default === undefined || isSecretField(field))
    return field.type === "boolean" ? false : "";
  return typeof field.default === "number" ? String(field.default) : field.default;
}

export function formFieldLabel(
  field: Pick<ChatFormField, "name" | "label">,
  known: Readonly<Record<string, string>>,
): CatalogLabel {
  if (field.label && field.label !== field.name) return { text: field.label, machine: false };
  const named = known[field.name];
  if (named) return { text: named, machine: false };
  return { text: field.name, machine: true };
}

export function formValues(
  form: ChatForm,
  values: Record<string, string | boolean | string[]>,
): Record<string, unknown> | null {
  const output: Record<string, unknown> = Object.create(null);
  for (const field of form.fields) {
    const raw = values[field.name];
    if (raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
      if (field.required) return null;
      continue;
    }
    if (field.type === "number") {
      if (typeof raw !== "string" || !Number.isFinite(Number(raw))) return null;
      output[field.name] = Number(raw);
    } else if (field.type === "json") {
      if (typeof raw !== "string") return null;
      try {
        JSON.parse(raw);
      } catch {
        return null;
      }
      output[field.name] = raw;
    } else if (field.type === "boolean") {
      if (typeof raw !== "boolean") return null;
      output[field.name] = raw;
    } else if (field.type === "multi") {
      if (
        !Array.isArray(raw) ||
        !raw.every((v) =>
          field.options?.some((option) => typeof option === "string" && option === v),
        )
      )
        return null;
      output[field.name] = raw;
    } else {
      if (typeof raw !== "string") return null;
      if (
        field.type === "select" &&
        !field.options?.some((o) => typeof o === "object" && o.value === raw)
      )
        return null;
      output[field.name] = raw;
    }
  }
  return output;
}
