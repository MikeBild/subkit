import { describe, expect, test } from "bun:test";
import {
  detectPlaceholderDestinationHint,
  placeholderDestinationHintMessage,
} from "./placeholder-destination.ts";

describe("detectPlaceholderDestinationHint — ask_user_form", () => {
  test("a field hint that is an example address is a placeholder destination", () => {
    const hit = detectPlaceholderDestinationHint("ask_user_form", {
      question: "Where should the report go?",
      fields: [
        {
          name: "recipient_email",
          label: "Recipient",
          type: "text",
          placeholder: "you@example.com",
        },
      ],
    });
    expect(hit).toEqual({
      field: "recipient_email",
      attribute: "placeholder",
      match: "you@example.com",
    });
  });

  test("a field default that is an example address is a placeholder destination", () => {
    const hit = detectPlaceholderDestinationHint("ask_user_form", {
      question: "Where should the report go?",
      fields: [{ name: "to", label: "Recipient", type: "text", default: "reports@example.com" }],
    });
    expect(hit).toEqual({ field: "to", attribute: "default", match: "reports@example.com" });
  });

  test("an example webhook host in a hint is a placeholder destination", () => {
    const hit = detectPlaceholderDestinationHint("ask_user_form", {
      question: "Where should the result be posted?",
      fields: [
        { name: "url", label: "Webhook", type: "text", placeholder: "https://hooks.example.com/x" },
      ],
    });
    expect(hit?.field).toBe("url");
    expect(hit?.match).toBe("hooks.example.com");
  });

  test("a neutral format hint and a runtime placeholder pass", () => {
    expect(
      detectPlaceholderDestinationHint("ask_user_form", {
        question: "Where should the report go?",
        fields: [
          { name: "to", label: "Recipient", type: "text", placeholder: "name@company.tld" },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a runtime placeholder the detector must skip
          { name: "cc", label: "Copy", type: "text", default: "${input.recipient}" },
        ],
      }),
    ).toBeNull();
  });

  test("labels and the question text are not scanned, so a refusal may name the placeholder", () => {
    expect(
      detectPlaceholderDestinationHint("ask_user_form", {
        question: "test@example.com is a placeholder — which real address should receive it?",
        fields: [{ name: "to", label: "Not test@example.com", type: "text" }],
      }),
    ).toBeNull();
  });
});

describe("detectPlaceholderDestinationHint — ask_user_text and other tools", () => {
  test("a text hint with an example address is caught", () => {
    expect(
      detectPlaceholderDestinationHint("ask_user_text", {
        question: "Recipient?",
        placeholder: "user@example.com",
      }),
    ).toEqual({ field: "question", attribute: "placeholder", match: "user@example.com" });
  });

  test("a text default with an example address is caught", () => {
    expect(
      detectPlaceholderDestinationHint("ask_user_text", {
        question: "Recipient?",
        default: "someone@yourdomain.com",
      }),
    ).toEqual({ field: "question", attribute: "default", match: "someone@yourdomain.com" });
  });

  test("a question that names the placeholder it refuses passes", () => {
    expect(
      detectPlaceholderDestinationHint("ask_user_text", {
        question:
          "test@example.com is a placeholder — which real address should receive the report?",
        placeholder: "name@company.tld",
      }),
    ).toBeNull();
  });

  test("choice and confirm tools are never scanned", () => {
    expect(
      detectPlaceholderDestinationHint("ask_user_choice", {
        question: "Which?",
        options: ["user@example.com"],
        default: "user@example.com",
      }),
    ).toBeNull();
    expect(
      detectPlaceholderDestinationHint("ask_user_confirm", { default: "x@example.com" }),
    ).toBeNull();
    expect(detectPlaceholderDestinationHint("ask_user_text", null)).toBeNull();
  });
});

describe("placeholderDestinationHintMessage", () => {
  test("names the field, the attribute and the value and tells the model what to do instead", () => {
    const message = placeholderDestinationHintMessage({
      field: "recipient_email",
      attribute: "placeholder",
      match: "you@example.com",
    });
    expect(message).toContain(
      'recipient_email.placeholder: placeholder destination "you@example.com"',
    );
    expect(message).toContain("ask again without the example value");
  });
});
