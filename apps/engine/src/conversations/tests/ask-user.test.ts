// Schema contract tests for the ask_user_* tool family. Pure unit tests —
// no DB. Guards the input shapes we stream to the client in the
// `tool_call_start` frame and persist into `conversation_elicitations.input`.

import { describe, expect, test } from "bun:test";
import {
  askUserChoiceTool,
  askUserConfirmTool,
  askUserFormTool,
  askUserMultiTool,
  askUserTextTool,
} from "../tools/ask-user/index.ts";

describe("ask_user_choice schema", () => {
  test("accepts a valid question + options", () => {
    const parsed = askUserChoiceTool.inputSchema.safeParse({
      question: "Which environment?",
      options: [
        { value: "dev", label: "Development" },
        { value: "prod", label: "Production", description: "cannot be undone" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects fewer than two options", () => {
    const parsed = askUserChoiceTool.inputSchema.safeParse({
      question: "pick?",
      options: [{ value: "only", label: "only" }],
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects missing question", () => {
    const parsed = askUserChoiceTool.inputSchema.safeParse({
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("ask_user_multi schema", () => {
  test("accepts min/max bounds", () => {
    const parsed = askUserMultiTool.inputSchema.safeParse({
      question: "Which skills?",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
      min: 1,
      max: 2,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("ask_user_text schema", () => {
  test("accepts plain question", () => {
    const parsed = askUserTextTool.inputSchema.safeParse({ question: "API key?" });
    expect(parsed.success).toBe(true);
  });

  test("accepts multiline + placeholder + validation_regex", () => {
    const parsed = askUserTextTool.inputSchema.safeParse({
      question: "Paste your config",
      placeholder: "{...}",
      multiline: true,
      validation_regex: "^\\{.*\\}$",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("ask_user_form schema", () => {
  test("accepts a form with typed fields", () => {
    const parsed = askUserFormTool.inputSchema.safeParse({
      question: "Connector credentials",
      fields: [
        { name: "key", label: "API key", type: "text", required: true },
        { name: "count", label: "Count", type: "number" },
        {
          name: "env",
          label: "Environment",
          type: "select",
          options: [
            { value: "dev", label: "dev" },
            { value: "prod", label: "prod" },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects empty fields array", () => {
    const parsed = askUserFormTool.inputSchema.safeParse({
      question: "nothing",
      fields: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("ask_user_confirm schema", () => {
  test("accepts commit_draft kind with diff", () => {
    const parsed = askUserConfirmTool.inputSchema.safeParse({
      question: "Commit this workflow?",
      kind: "commit_draft",
      summary: "Creates workflow `orders-sync`",
      diff: { before: null, after: { name: "orders-sync" } },
    });
    expect(parsed.success).toBe(true);
  });

  test("defaults kind to generic when omitted", () => {
    const parsed = askUserConfirmTool.inputSchema.safeParse({
      question: "Proceed?",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { kind: string }).kind).toBe("generic");
    }
  });

  test("accepts destructive + default hints", () => {
    const parsed = askUserConfirmTool.inputSchema.safeParse({
      question: "Delete?",
      destructive: true,
      default: "reject",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("askUser tool identity", () => {
  test("each tool exposes a stable name", () => {
    expect(askUserChoiceTool.name).toBe("ask_user_choice");
    expect(askUserMultiTool.name).toBe("ask_user_multi");
    expect(askUserTextTool.name).toBe("ask_user_text");
    expect(askUserFormTool.name).toBe("ask_user_form");
    expect(askUserConfirmTool.name).toBe("ask_user_confirm");
  });
});
