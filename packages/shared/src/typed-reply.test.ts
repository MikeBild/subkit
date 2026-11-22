import { describe, expect, test } from "bun:test";
import { questionClass, typedReply, typedYesNo } from "./typed-reply.ts";

const confirm = { tool_name: "ask_user_confirm", input: { question: "Send the reminder?" } };
const choice = {
  tool_name: "ask_user_choice",
  input: {
    question: "When?",
    options: [
      { value: "today", label: "Today" },
      { value: "tomorrow", label: "Tomorrow morning" },
      { value: "nordic", label: "Nordic office" },
    ],
  },
};

describe("a typed reply while a question is open", () => {
  test("a clear yes or no answers a plain confirmation", () => {
    for (const text of ["ja", "Yes!", "  ok. ", "Mach das", "allow once"])
      expect(typedReply(confirm, text)).toEqual({ kind: "answer", output: { confirmed: true } });
    for (const text of ["nein", "No.", "lieber nicht", "Abbrechen"])
      expect(typedReply(confirm, text)).toEqual({ kind: "answer", output: { confirmed: false } });
  });

  test("anything else leaves the confirmation open and reaches the agent as a message", () => {
    for (const text of ["sounds good, go ahead", "yes but only to Ada", "what does it send?", ""])
      expect(typedReply(confirm, text)).toEqual({ kind: "message" });
  });

  test("a reply that names exactly one option answers a choice", () => {
    expect(typedReply(choice, "today")).toEqual({ kind: "answer", output: { value: "today" } });
    expect(typedReply(choice, "Tomorrow morning.")).toEqual({
      kind: "answer",
      output: { value: "tomorrow" },
    });
  });

  test("a partial or unknown option is not an answer", () => {
    for (const text of ["morning", "no", "today or tomorrow", "Nord"])
      expect(typedReply(choice, text)).toEqual({ kind: "message" });
  });

  test("a reply that names two options at once is not an answer", () => {
    const twice = {
      tool_name: "ask_user_choice",
      input: {
        options: [
          { value: "a", label: "Berlin" },
          { value: "berlin", label: "Hamburg" },
        ],
      },
    };
    expect(typedReply(twice, "berlin")).toEqual({ kind: "message" });
  });

  test("a multi-choice question is answered with its controls only", () => {
    const multi = { tool_name: "ask_user_multi", input: { options: choice.input.options } };
    expect(typedReply(multi, "today")).toEqual({ kind: "message" });
  });

  test("a text question and a form with one field take the reply as the answer", () => {
    expect(typedReply({ tool_name: "ask_user_text" }, "Berlin")).toEqual({
      kind: "answer",
      output: { text: "Berlin" },
    });
    const form = { tool_name: "ask_user_form", input: { fields: [{ name: "email" }] } };
    expect(typedReply(form, "ada@example.com")).toEqual({
      kind: "answer",
      output: { email: "ada@example.com" },
    });
  });

  test("a form with several fields stays open", () => {
    const form = { tool_name: "ask_user_form", input: { fields: [{ name: "a" }, { name: "b" }] } };
    expect(typedReply(form, "Berlin Germany")).toEqual({ kind: "message" });
  });

  test("yes and no ignore case, spacing and closing punctuation", () => {
    expect(typedYesNo("  JA !")).toBe(true);
    expect(typedYesNo("do  it")).toBe(true);
    expect(typedYesNo("nö")).toBe(false);
    expect(typedYesNo("vielleicht")).toBeNull();
    expect(typedYesNo("ja ".repeat(10))).toBeNull();
  });
});

describe("typed text never gives an approval", () => {
  const authority = [
    { question: "Send the reminder?", commit_intent: { kind: "execute_confirmed_tool_call" } },
    { question: "Allow once?", approval_url: "https://subkit.example/approve/1" },
    { question: "Write the file?", kind: "external_write" },
    { question: "Save the draft?", kind: "save_workflow_draft" },
    { question: "Delete it?", destructive: true },
    { question: "PATCH the record?", effect: { connector: "CRM", method: "PATCH" } },
    { question: "Run on your Mac?", device: { tool: "shell" } },
    { question: "Apply these changes?", diffs: [{ label: "a" }] },
  ];

  test("a confirmation that lets a write or effect run is answered with its buttons only", () => {
    for (const input of authority) {
      const question = { tool_name: "ask_user_confirm", input };
      expect(questionClass(question)).toBe("button_only");
      expect(typedReply(question, "ja")).toEqual({ kind: "message" });
      expect(typedReply(question, "nein")).toEqual({ kind: "message" });
    }
  });

  test("an option that releases an approval is not chosen by typing", () => {
    const question = {
      tool_name: "ask_user_choice",
      input: { ...choice.input, commit_intent: { kind: "execute_confirmed_tool_call" } },
    };
    expect(questionClass(question)).toBe("button_only");
    expect(typedReply(question, "today")).toEqual({ kind: "message" });
  });

  test("a plain question with nothing attached takes typed answers", () => {
    expect(questionClass(confirm)).toBe("typed");
    expect(
      questionClass({ tool_name: "ask_user_confirm", input: { question: "Ok?", kind: "generic" } }),
    ).toBe("typed");
    expect(questionClass(choice)).toBe("typed");
    expect(questionClass({ tool_name: "ask_user_text" })).toBe("typed");
  });
});

describe("a form that asks for a secret", () => {
  test("refuses typed text so it is never stored as a message", () => {
    for (const field of [
      { name: "token", type: "password" },
      { name: "key", type: "text", sensitive: true },
    ]) {
      const question = { tool_name: "ask_user_form", input: { fields: [field] } };
      expect(questionClass(question)).toBe("secret");
      expect(typedReply(question, "sk-live-123")).toEqual({ kind: "refused" });
    }
  });
});
