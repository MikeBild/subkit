import type { ConversationDetail } from "@/api/client";

type Pending = NonNullable<NonNullable<ConversationDetail["resume_summary"]>["pending_approval"]>;
export type ChatFormField = NonNullable<NonNullable<Pending["prompt"]>["fields"]>[number];
export interface ChatForm {
  id: string;
  toolCallId: string;
  question: string;
  fields: ChatFormField[];
  expiresAt: string;
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
  };
}

/**
 * A field's label as a reader sees it.
 *
 * The engine sends a label; when the model gave none it is the field's own
 * name — `report_recipient_email`. A handful of names have a word in the
 * catalogue; every other one used to reach the form as the raw identifier.
 * Spaced and capitalised it reads as a label and still matches what the
 * workflow calls the input.
 */
export function formFieldLabel(
  field: Pick<ChatFormField, "name" | "label">,
  known: Readonly<Record<string, string>>,
): string {
  if (field.label && field.label !== field.name) return field.label;
  const named = known[field.name];
  if (named) return named;
  const words = field.name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : field.name;
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
