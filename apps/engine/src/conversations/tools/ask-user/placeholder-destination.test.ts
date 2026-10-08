import { describe, expect, test } from "bun:test";
import {
  describeDroppedHints,
  stripPlaceholderDestinationHints,
} from "./placeholder-destination.ts";

describe("stripPlaceholderDestinationHints — ask_user_form", () => {
  test("a field hint that is an example address is dropped and the rest of the field stays", () => {
    const { input, dropped } = stripPlaceholderDestinationHints("ask_user_form", {
      question: "Where should the report go?",
      fields: [
        {
          name: "recipient_email",
          label: "Recipient",
          type: "text",
          placeholder: "you@example.com",
          required: true,
        },
      ],
    });
    expect(dropped).toEqual([
      { field: "recipient_email", attribute: "placeholder", match: "you@example.com" },
    ]);
    expect(input).toEqual({
      question: "Where should the report go?",
      fields: [{ name: "recipient_email", label: "Recipient", type: "text", required: true }],
    });
  });

  test("a field default that is an example address is dropped", () => {
    const { input, dropped } = stripPlaceholderDestinationHints("ask_user_form", {
      question: "Where should the report go?",
      fields: [{ name: "to", label: "Recipient", type: "text", default: "reports@example.com" }],
    });
    expect(dropped).toEqual([{ field: "to", attribute: "default", match: "reports@example.com" }]);
    expect((input as { fields: Record<string, unknown>[] }).fields[0]).toEqual({
      name: "to",
      label: "Recipient",
      type: "text",
    });
  });

  test("an example webhook host in a hint is dropped", () => {
    const { dropped } = stripPlaceholderDestinationHints("ask_user_form", {
      question: "Where should the result be posted?",
      fields: [
        { name: "url", label: "Webhook", type: "text", placeholder: "https://hooks.example.com/x" },
      ],
    });
    expect(dropped).toEqual([
      { field: "url", attribute: "placeholder", match: "hooks.example.com" },
    ]);
  });

  test("a neutral format hint and a runtime placeholder stay and the input is returned as is", () => {
    const original = {
      question: "Where should the report go?",
      fields: [
        { name: "to", label: "Recipient", type: "text", placeholder: "name@company.tld" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a runtime placeholder the detector must skip
        { name: "cc", label: "Copy", type: "text", default: "${input.recipient}" },
      ],
    };
    const { input, dropped } = stripPlaceholderDestinationHints("ask_user_form", original);
    expect(dropped).toEqual([]);
    expect(input).toBe(original);
  });

  test("labels and the question text are untouched, so a refusal may name the placeholder", () => {
    const original = {
      question: "test@example.com is a placeholder — which real address should receive it?",
      fields: [{ name: "to", label: "Not test@example.com", type: "text" }],
    };
    const { input, dropped } = stripPlaceholderDestinationHints("ask_user_form", original);
    expect(dropped).toEqual([]);
    expect(input).toBe(original);
  });
});

describe("stripPlaceholderDestinationHints — ask_user_text and other tools", () => {
  test("a text hint with an example address is dropped", () => {
    const { input, dropped } = stripPlaceholderDestinationHints("ask_user_text", {
      question: "Recipient?",
      placeholder: "user@example.com",
      multiline: false,
    });
    expect(dropped).toEqual([
      { field: "question", attribute: "placeholder", match: "user@example.com" },
    ]);
    expect(input).toEqual({ question: "Recipient?", multiline: false });
  });

  test("a text default with an example address is dropped", () => {
    const { input, dropped } = stripPlaceholderDestinationHints("ask_user_text", {
      question: "Recipient?",
      default: "someone@yourdomain.com",
    });
    expect(dropped).toEqual([
      { field: "question", attribute: "default", match: "someone@yourdomain.com" },
    ]);
    expect(input).toEqual({ question: "Recipient?" });
  });

  test("a question that names the placeholder it refuses is returned as is", () => {
    const original = {
      question: "test@example.com is a placeholder — which real address should receive the report?",
      placeholder: "name@company.tld",
    };
    const { input, dropped } = stripPlaceholderDestinationHints("ask_user_text", original);
    expect(dropped).toEqual([]);
    expect(input).toBe(original);
  });

  test("choice and confirm tools and non-object inputs are never touched", () => {
    const choice = {
      question: "Which?",
      options: ["user@example.com"],
      default: "user@example.com",
    };
    expect(stripPlaceholderDestinationHints("ask_user_choice", choice)).toEqual({
      input: choice,
      dropped: [],
    });
    expect(stripPlaceholderDestinationHints("ask_user_text", null)).toEqual({
      input: null,
      dropped: [],
    });
  });
});

describe("describeDroppedHints", () => {
  test("names each field, attribute and value", () => {
    expect(
      describeDroppedHints([
        { field: "recipient_email", attribute: "placeholder", match: "you@example.com" },
        { field: "question", attribute: "default", match: "user@example.com" },
      ]),
    ).toBe('recipient_email.placeholder="you@example.com", question.default="user@example.com"');
  });
});
