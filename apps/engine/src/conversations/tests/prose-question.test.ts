// closingProseQuestion — the deterministic half of the prose-question
// parking in loop.ts turn finalization. Only a direct trailing question
// counts; the returned ask is the closing paragraph, capped.

import { describe, expect, test } from "bun:test";
import { closingProseQuestion } from "../prose-question.ts";

describe("closingProseQuestion", () => {
  test("null/empty/whitespace → null", () => {
    expect(closingProseQuestion(null)).toBeNull();
    expect(closingProseQuestion(undefined)).toBeNull();
    expect(closingProseQuestion("   \n  ")).toBeNull();
  });

  test("statement ending → null", () => {
    expect(closingProseQuestion("The workflow is committed and live.")).toBeNull();
  });

  test("mid-text question with statement ending → null", () => {
    expect(
      closingProseQuestion("Which connector should I use? I went with the GitHub connector."),
    ).toBeNull();
  });

  test("direct trailing question → the closing paragraph", () => {
    const text = [
      "I drafted the workflow with three steps.",
      "",
      "Should I schedule it daily at 9am, or run it on demand?",
    ].join("\n");
    expect(closingProseQuestion(text)).toBe(
      "Should I schedule it daily at 9am, or run it on demand?",
    );
  });

  test("multi-line closing paragraph is returned whole", () => {
    const text = [
      "Setup done.",
      "",
      "Two options remain:",
      "- daily at 9am",
      "- on demand",
      "Which one do you want?",
    ].join("\n");
    const ask = closingProseQuestion(text);
    expect(ask).toContain("Two options remain:");
    expect(ask).toContain("Which one do you want?");
  });

  test("trailing whitespace after the question mark still counts", () => {
    expect(closingProseQuestion("Proceed with the live send?  \n")).toBe(
      "Proceed with the live send?",
    );
  });

  test("overlong closing ask is capped from the tail", () => {
    const filler = "x".repeat(1000);
    const ask = closingProseQuestion(`${filler} — proceed?`);
    expect(ask).not.toBeNull();
    expect(ask!.length).toBeLessThanOrEqual(600);
    expect(ask!.endsWith("proceed?")).toBe(true);
  });
});
