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
