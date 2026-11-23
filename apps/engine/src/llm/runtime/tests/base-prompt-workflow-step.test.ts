import { describe, expect, test } from "bun:test";
import { UNTRUSTED_CONTENT_NOTE } from "@shared/untrusted-content.ts";
import { basePromptFor } from "../context-assembler.ts";

describe("workflow step base prompt", () => {
  test("without an author system prompt the guard and the untrusted-content note are sent", async () => {
    const { content } = await basePromptFor("workflow_step");
    expect(content).toStartWith("You are one step of a business workflow.");
    expect(content).toEndWith(UNTRUSTED_CONTENT_NOTE);
  });

  test("the author's system prompt follows the guard and never replaces it", async () => {
    const { content } = await basePromptFor(
      "workflow_step",
      undefined,
      undefined,
      "  You sort support messages.  ",
    );
    expect(content).toStartWith("You are one step of a business workflow.");
    expect(content).toContain(`\n\n${UNTRUSTED_CONTENT_NOTE}\n\n`);
    expect(content).toEndWith("\n\nYou sort support messages.");
  });

  test("a blank author system prompt adds nothing", async () => {
    expect((await basePromptFor("workflow_step", undefined, undefined, "   ")).content).toBe(
      (await basePromptFor("workflow_step")).content,
    );
  });
});
