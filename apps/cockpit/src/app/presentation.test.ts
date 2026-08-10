import { describe, expect, test } from "bun:test";
import { conversationExcerpt, hideTechnicalIdentifiers } from "@/lib/presentation";

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
});
