import { expect, test } from "bun:test";
import type { ConversationDetail } from "@/api/client";
import {
  type ChatForm,
  chatForm,
  formFieldLabel,
  formInputKind,
  formValues,
  initialFieldValue,
} from "./chat-form";

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

test("a field without a label is its name, marked as one — never invented prose", () => {
  const known = { period_end: "Periodenende" };
  expect(formFieldLabel({ name: "period_end", label: "period_end" }, known)).toEqual({
    text: "Periodenende",
    machine: false,
  });
  // Not dressed up as English prose: the input's own name, shown as a name.
  expect(
    formFieldLabel({ name: "report_recipient_email", label: "report_recipient_email" }, known),
  ).toEqual({ text: "report_recipient_email", machine: true });
  // A label the engine did send is the author's word and stays.
  expect(formFieldLabel({ name: "site", label: "Website" }, known)).toEqual({
    text: "Website",
    machine: false,
  });
});

// The engine's credential form: `ask_user_form` with a masked `token` field.
const credentialForm: ChatForm = {
  id: "credential",
  toolCallId: "ask",
  question: "Enter the Metabase API key",
  expiresAt: "2030-01-01T00:00:00Z",
  intentKind: "save_connector_draft",
  fields: [
    { name: "token", label: "API key", type: "password", sensitive: true, required: true },
    { name: "host", label: "Host", type: "text", default: "metabase.example.test" },
  ],
};

test("a credential form is answerable: its secret field is masked, required and sent as text", () => {
  const detail = {
    tool_calls: [{ id: "ask", tool: "ask_user_form", input: {} }],
    resume_summary: {
      pending_approval: {
        id: "credential",
        tool_call_id: "ask",
        tool_name: "ask_user_form",
        expires_at: credentialForm.expiresAt,
        prompt: {
          question: credentialForm.question,
          fields: credentialForm.fields,
          intent_kind: "save_connector_draft",
        },
      },
    },
  } as unknown as ConversationDetail;
  expect(chatForm(detail)).toEqual(credentialForm);
  expect(formValues(credentialForm, { token: "", host: "h" })).toBeNull();
  expect(formValues(credentialForm, { token: "s3cr3t", host: "h" })).toEqual({
    token: "s3cr3t",
    host: "h",
  });
});

test("every field type has a control; secrets are masked and never pre-filled", () => {
  expect(formInputKind({ type: "password" })).toBe("secret");
  expect(formInputKind({ type: "text", sensitive: true })).toBe("secret");
  expect(formInputKind({ type: "json", sensitive: true })).toBe("secret");
  expect(formInputKind({ type: "text" })).toBe("text");
  expect(formInputKind({ type: "number" })).toBe("number");
  expect(formInputKind({ type: "json" })).toBe("textarea");
  expect(formInputKind({ type: "boolean" })).toBe("checkbox");
  expect(formInputKind({ type: "select" })).toBe("select");
  expect(formInputKind({ type: "multi" })).toBe("multi");
  expect(
    initialFieldValue({ name: "t", label: "T", type: "password", default: "leaked-default" }),
  ).toBe("");
  expect(
    initialFieldValue({ name: "t", label: "T", type: "text", sensitive: true, default: "leak" }),
  ).toBe("");
  expect(initialFieldValue({ name: "n", label: "N", type: "number", default: 3 })).toBe("3");
});
