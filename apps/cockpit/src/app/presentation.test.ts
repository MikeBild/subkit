import { describe, expect, test } from "bun:test";
import { conversationExcerpt, hideTechnicalIdentifiers } from "@/lib/presentation";
import { asToolPart } from "@/lib/tool-parts";
import { asStreamedDiff } from "@/pages/chat";

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

describe("streamed diff frames", () => {
  test("renders the hunks the engine already computed", () => {
    const diff = asStreamedDiff({
      type: "diff",
      title: "radar-collect-weekly · v4",
      language: "json",
      hunks: [
        { kind: " ", text: "{" },
        { kind: "-", text: '  "data_selector": "data.id"' },
        { kind: "+", text: '  "data_selector": "data.result.id"' },
      ],
    });
    expect(diff?.title).toBe("radar-collect-weekly · v4");
    expect(diff?.lines).toEqual([
      { type: "context", text: "{" },
      { type: "removed", text: '  "data_selector": "data.id"' },
      { type: "added", text: '  "data_selector": "data.result.id"' },
    ]);
  });

  test("ignores every other frame and empty diffs", () => {
    expect(asStreamedDiff({ type: "text_delta", text: "hallo" })).toBeNull();
    expect(asStreamedDiff({ type: "diff", hunks: [] })).toBeNull();
    expect(asStreamedDiff({ type: "diff" })).toBeNull();
  });

  test("an unknown hunk marker reads as context rather than being dropped", () => {
    const diff = asStreamedDiff({ type: "diff", hunks: [{ kind: "?", text: "unklar" }] });
    expect(diff?.lines).toEqual([{ type: "context", text: "unklar" }]);
  });
});
