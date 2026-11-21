import { describe, expect, test } from "bun:test";
import { asStreamedDiff } from "@/features/chat";
import { asToolPart } from "@/features/chat/model/tool-parts";
import { conversationExcerpt, hideTechnicalIdentifiers, humanFacingText } from "@/lib/presentation";

describe("cockpit presentation", () => {
  test("hides UUIDs in conversational text", () => {
    expect(
      hideTechnicalIdentifiers(
        "Execution 018f4b4a-6d33-7b3a-9c2d-123456789abc completed",
        "technical reference",
      ),
    ).toBe("Execution technical reference completed");
  });

  test("hides UUID-shaped references even when their variant nibble is nonstandard", () => {
    expect(
      humanFacingText(
        "Inspect conversation 8b2d0827-01b5-4e4a-2b98-0c0e83d9c9ba",
        "reference hidden",
      ),
    ).toBe("Inspect conversation reference hidden");
  });

  test("hides UUID-shaped references that historical titles already clipped", () => {
    const titles = [
      "Create a schedule for workflow id 3fb5fc90-8e4c-4…",
      "Inspect conversation 8b2d0827-01b5-4e4a-952e-2b98…",
      "Lies @file:fid_b99107c1-a44e-4b35-8c26-32af17d2fa…",
      '{"$file":"fid_a4ec8e9a-d3b4-4151-8bd2-26ac6d3a8bf…',
    ];

    for (const title of titles) {
      expect(humanFacingText(title, "reference hidden")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
  });

  test("hides file references and canonicalizes the product name", () => {
    expect(
      humanFacingText(
        "Lies fid_b99107c1-a44e-4b35-8c26-32af17d2fac8 mit subkit",
        "technical reference",
      ),
    ).toBe("Lies technical reference mit SubKit");
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
