import { describe, expect, test } from "bun:test";
import {
  decodeAskUserPromptEscapes,
  decodeLiteralUnicodeEscapes,
} from "./decode-prompt-escapes.ts";

describe("decodeLiteralUnicodeEscapes", () => {
  test("decodes a literal BMP escape", () => {
    expect(decodeLiteralUnicodeEscapes("Wie soll dein Workflow hei\\u00dfen?")).toBe(
      "Wie soll dein Workflow heißen?",
    );
  });

  test("decodes typographic quotes and mixed case hex", () => {
    expect(decodeLiteralUnicodeEscapes("(z.B. \\u201cExample\\u201D)")).toBe("(z.B. “Example”)");
  });

  test("joins a surrogate pair into one code point", () => {
    expect(decodeLiteralUnicodeEscapes("Done \\ud83d\\ude80")).toBe("Done 🚀");
  });

  test("leaves a lone high or low surrogate as written", () => {
    expect(decodeLiteralUnicodeEscapes("a\\ud83d b")).toBe("a\\ud83d b");
    expect(decodeLiteralUnicodeEscapes("a\\ude80 b")).toBe("a\\ude80 b");
    expect(decodeLiteralUnicodeEscapes("a\\ud83d\\u00df")).toBe("a\\ud83dß");
  });

  test("leaves an invalid sequence as written", () => {
    expect(decodeLiteralUnicodeEscapes("C:\\users\\uZZZZ and \\u12")).toBe(
      "C:\\users\\uZZZZ and \\u12",
    );
  });

  test("leaves an escaped backslash followed by u as written", () => {
    expect(decodeLiteralUnicodeEscapes("regex \\\\u00df")).toBe("regex \\\\u00df");
  });

  test("never manufactures a control character", () => {
    expect(decodeLiteralUnicodeEscapes("a\\u0000b\\u000a")).toBe("a\\u0000b\\u000a");
  });

  test("already-decoded text comes back unchanged", () => {
    const text = "Wie soll dein Workflow heißen? (z.B. “Example API Daten abrufen”) 🚀";
    expect(decodeLiteralUnicodeEscapes(text)).toBe(text);
  });
});

describe("decodeAskUserPromptEscapes", () => {
  test("decodes the human-facing text of ask_user_text, including its default", () => {
    const out = decodeAskUserPromptEscapes("ask_user_text", {
      question: "Wie soll dein Workflow hei\\u00dfen?",
      placeholder: "z.B. \\u201cDaten\\u201d",
      default: "Gr\\u00fc\\u00dfe",
      validation_regex: "^[\\u00c0-\\u017f]+$",
    });
    expect(out).toEqual({
      question: "Wie soll dein Workflow heißen?",
      placeholder: "z.B. “Daten”",
      default: "Grüße",
      validation_regex: "^[\\u00c0-\\u017f]+$",
    });
  });

  test("decodes option labels and descriptions, never option values or a choice default", () => {
    const out = decodeAskUserPromptEscapes("ask_user_choice", {
      question: "W\\u00e4hle",
      options: [
        { value: "gr\\u00fcn", label: "Gr\\u00fcn", description: "Gef\\u00e4llt" },
        { value: "rot", label: "Rot" },
      ],
      default: "gr\\u00fcn",
    });
    expect(out).toEqual({
      question: "Wähle",
      options: [
        { value: "gr\\u00fcn", label: "Grün", description: "Gefällt" },
        { value: "rot", label: "Rot" },
      ],
      default: "gr\\u00fcn",
    });
  });

  test("decodes form field labels, placeholders and text defaults, never names or select values", () => {
    const out = decodeAskUserPromptEscapes("ask_user_form", {
      question: "Stra\\u00dfe",
      fields: [
        {
          name: "stra\\u00dfe",
          label: "Stra\\u00dfe",
          type: "text",
          placeholder: "Hauptstra\\u00dfe 1",
          default: "Gro\\u00dfe Gasse",
        },
        {
          name: "land",
          label: "L\\u00e4nder",
          type: "select",
          options: [{ value: "\\u00f6", label: "\\u00d6sterreich" }],
          default: "\\u00f6",
        },
        { name: "tags", label: "Tags", type: "multi", options: ["gr\\u00fcn"] },
      ],
    });
    expect(out).toEqual({
      question: "Straße",
      fields: [
        {
          name: "stra\\u00dfe",
          label: "Straße",
          type: "text",
          placeholder: "Hauptstraße 1",
          default: "Große Gasse",
        },
        {
          name: "land",
          label: "Länder",
          type: "select",
          options: [{ value: "\\u00f6", label: "Österreich" }],
          default: "\\u00f6",
        },
        { name: "tags", label: "Tags", type: "multi", options: ["gr\\u00fcn"] },
      ],
    });
  });

  test("decodes a confirm question and summary but never its commit intent or target", () => {
    const commit_intent = {
      kind: "save_workflow_draft",
      payload: { code: 'return "\\u00df";' },
      description: "Speichern",
    };
    const out = decodeAskUserPromptEscapes("ask_user_confirm", {
      question: "Speichern? Gr\\u00fc\\u00dfe",
      summary: "Gro\\u00dfe \\u00c4nderung",
      kind: "generic",
      target: { label: "\\u00df" },
      commit_intent,
    });
    expect(out).toEqual({
      question: "Speichern? Grüße",
      summary: "Große Änderung",
      kind: "generic",
      target: { label: "\\u00df" },
      commit_intent,
    });
  });

  test("returns the same reference when nothing needs decoding, and ignores other tools", () => {
    const clean = { question: "Wie soll dein Workflow heißen?" };
    expect(decodeAskUserPromptEscapes("ask_user_text", clean)).toBe(clean);
    const other = { question: "hei\\u00dfen" };
    expect(decodeAskUserPromptEscapes("edit_workflow_patch", other)).toBe(other);
  });
});
