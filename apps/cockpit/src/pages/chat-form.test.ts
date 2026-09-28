import { expect, test } from "bun:test";
import type { ConversationDetail } from "@/api/client";
import { type ChatForm, chatForm, formFieldLabel, formValues } from "./chat-form";

const form: ChatForm = {
  id: "question",
  toolCallId: "runner",
  question: "Report details",
  expiresAt: "2030-01-01T00:00:00Z",
  fields: [
    { name: "days", label: "Days", type: "number", required: true },
    { name: "include", label: "Include", type: "boolean" },
    {
      name: "format",
      label: "Format",
      type: "select",
      options: [{ value: "short", label: "Short" }],
    },
    { name: "projects", label: "Projects", type: "multi", options: ["one", "two"] },
    { name: "data", label: "Data", type: "json" },
  ],
};
test("pending form belongs to originating run tool, not a fabricated ask tool", () => {
  const detail = {
    tool_calls: [{ id: "runner", tool: "run_workflow", input: { execute_writes: false } }],
    resume_summary: {
      pending_approval: {
        id: form.id,
        tool_call_id: form.toolCallId,
        tool_name: "ask_user_form",
        expires_at: form.expiresAt,
        prompt: { question: form.question, fields: form.fields },
      },
    },
  } as unknown as ConversationDetail;
  expect(chatForm(detail)).toEqual(form);
  expect(chatForm({ ...detail, tool_calls: [] })).toBeNull();
  expect(chatForm(undefined)).toBeNull();
});
test("typed form values preserve false, validate choices and never copy unrelated fields", () => {
  expect(
    formValues(form, {
      days: "7",
      include: false,
      format: "short",
      projects: ["one"],
      data: "{}",
      extra: "omit",
    }),
  ).toEqual({ days: 7, include: false, format: "short", projects: ["one"], data: "{}" });
  expect(formValues(form, { days: "" })).toBeNull();
  expect(formValues(form, { days: "NaN" })).toBeNull();
  expect(formValues(form, { days: "7", data: "{" })).toBeNull();
  expect(formValues(form, { days: "7", format: "foreign" })).toBeNull();
  expect(formValues(form, { days: "7", projects: ["foreign"] })).toBeNull();
});

test("a field without a label reads as words, never as its raw name", () => {
  const known = { period_end: "Periodenende" };
  expect(formFieldLabel({ name: "period_end", label: "period_end" }, known)).toBe("Periodenende");
  expect(
    formFieldLabel({ name: "report_recipient_email", label: "report_recipient_email" }, known),
  ).toBe("Report recipient email");
  expect(formFieldLabel({ name: "maxRows", label: "maxRows" }, known)).toBe("Max rows");
  // A label the engine did send is the author's word and stays.
  expect(formFieldLabel({ name: "site", label: "Website" }, known)).toBe("Website");
});
