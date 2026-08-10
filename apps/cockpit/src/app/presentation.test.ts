import { describe, expect, test } from "bun:test";
import { conversationExcerpt, hideTechnicalIdentifiers } from "@/lib/presentation";
import { asToolPart } from "@/pages/chat";

describe("cockpit presentation", () => {
  test("hides UUIDs in conversational text", () => {
    expect(
      hideTechnicalIdentifiers(
        "Execution 018f4b4a-6d33-7b3a-9c2d-123456789abc completed",
        "technical reference",
      ),
    ).toBe("Execution technical reference completed");
  });

  test("turns raw tool payload excerpts into a readable label", () => {
    expect(
      conversationExcerpt(
        '{"tool":"run_workflow","output":{"status":"completed"}}',
        "Governed action completed",
        "technical reference",
      ),
    ).toBe("Governed action completed");
  });

  test("keeps dynamic tool calls in the visible conversation", () => {
    expect(
      asToolPart({
        type: "dynamic-tool",
        toolName: "validate_workflow",
        state: "output-available",
      }),
    ).not.toBeNull();
    expect(asToolPart({ type: "text", text: "hello" })).toBeNull();
  });
});
