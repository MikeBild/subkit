import { describe, expect, test } from "bun:test";
import { assembleSuggestionPrompt, SUGGESTION_SYSTEM_PROMPT } from "../suggestion-prompt.ts";

describe("assembleSuggestionPrompt", () => {
  test("returns the static system prompt verbatim", () => {
    const out = assembleSuggestionPrompt({ recent_messages: [] });
    expect(out.system).toBe(SUGGESTION_SYSTEM_PROMPT);
  });

  test("forwards the message history with role + content (appends user nudge when tail is assistant)", () => {
    const out = assembleSuggestionPrompt({
      recent_messages: [
        { role: "user", text: "should I commit?" },
        { role: "assistant", text: "Want me to commit and push it?" },
      ],
    });
    expect(out.messages).toEqual([
      { role: "user", content: "should I commit?" },
      { role: "assistant", content: "Want me to commit and push it?" },
      { role: "user", content: "What would I type next?" },
    ]);
  });

  test("respects max_history by keeping the most recent turns", () => {
    const recent: Array<{ role: "user" | "assistant"; text: string }> = Array.from(
      { length: 12 },
      (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        text: `msg-${i}`,
      }),
    );
    // Tail of length 4 ends with "msg-11" (assistant) → user nudge
    // appended to make the array end with a user message.
    const out = assembleSuggestionPrompt({ recent_messages: recent, max_history: 4 });
    expect(out.messages.map((m) => m.content)).toEqual([
      "msg-8",
      "msg-9",
      "msg-10",
      "msg-11",
      "What would I type next?",
    ]);
    expect(out.messages[out.messages.length - 1]!.role).toBe("user");
  });

  test("drops empty / whitespace-only messages, then appends user nudge when tail is assistant", () => {
    const out = assembleSuggestionPrompt({
      recent_messages: [
        { role: "user", text: "" },
        { role: "user", text: "   " },
        { role: "assistant", text: "real" },
      ],
    });
    expect(out.messages).toEqual([
      { role: "assistant", content: "real" },
      { role: "user", content: "What would I type next?" },
    ]);
  });

  test("does NOT append user nudge when tail already ends with user", () => {
    const out = assembleSuggestionPrompt({
      recent_messages: [
        { role: "assistant", text: "Anything else?" },
        { role: "user", text: "list workflows" },
      ],
    });
    expect(out.messages).toEqual([
      { role: "assistant", content: "Anything else?" },
      { role: "user", content: "list workflows" },
    ]);
  });

  test("regression — provider-rejected assistant prefill: messages always end with user", () => {
    // Production warn `suggest_next.model_invoker_threw` at v4.10.0:
    //   "This model does not support assistant message prefill. The
    //    conversation must end with a user message."
    // Suggest-next runs immediately after an assistant turn, so without
    // the user-nudge appender every model call ended with assistant
    // role. This test pins the invariant: the tail role is always user
    // (when there is any history at all).
    const fixtures: Array<Array<{ role: "user" | "assistant"; text: string }>> = [
      [{ role: "assistant", text: "ok" }],
      [
        { role: "user", text: "do x" },
        { role: "assistant", text: "done" },
      ],
      [
        { role: "user", text: "a" },
        { role: "assistant", text: "b" },
        { role: "user", text: "c" },
        { role: "assistant", text: "d" },
      ],
    ];
    for (const recent_messages of fixtures) {
      const out = assembleSuggestionPrompt({ recent_messages });
      expect(out.messages.length).toBeGreaterThan(0);
      expect(out.messages[out.messages.length - 1]!.role).toBe("user");
    }
  });

  test("tail-trims oversized messages with an ellipsis prefix", () => {
    const long = "abcdefghij".repeat(200); // 2000 chars
    const out = assembleSuggestionPrompt({
      recent_messages: [{ role: "assistant", text: long }],
      max_chars_per_message: 50,
    });
    const content = out.messages[0]?.content as string;
    expect(typeof content).toBe("string");
    expect(content.startsWith("…")).toBe(true);
    expect(content.length).toBeLessThanOrEqual(51);
  });

  test("handles empty input safely", () => {
    const out = assembleSuggestionPrompt({ recent_messages: [] });
    expect(out.messages).toEqual([]);
    expect(out.system.length).toBeGreaterThan(0);
  });
});
