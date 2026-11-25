import { describe, expect, test } from "bun:test";
import {
  canOpenElicitation,
  canTransitionConversation,
  conversationSources,
} from "./conversation-status.ts";

describe("conversation transitions", () => {
  test("an open conversation waits for input, resumes, commits or is abandoned", () => {
    expect(canTransitionConversation("active", "awaiting_input")).toBe(true);
    expect(canTransitionConversation("awaiting_input", "active")).toBe(true);
    expect(canTransitionConversation("active", "committed")).toBe(true);
    expect(canTransitionConversation("awaiting_input", "abandoned")).toBe(true);
  });

  test("a committed conversation may be reopened or abandoned but never waits", () => {
    expect(canTransitionConversation("committed", "active")).toBe(true);
    expect(canTransitionConversation("committed", "abandoned")).toBe(true);
    expect(canTransitionConversation("committed", "awaiting_input")).toBe(false);
  });

  test("an abandoned conversation stays abandoned", () => {
    expect(conversationSources("active")).toEqual(["active", "awaiting_input", "committed"]);
    expect(canTransitionConversation("abandoned", "active")).toBe(false);
    expect(canTransitionConversation("abandoned", "abandoned")).toBe(false);
  });

  test("sources narrow to the states a caller allows", () => {
    expect(conversationSources("active", ["awaiting_input", "abandoned"])).toEqual([
      "awaiting_input",
    ]);
  });

  test("an abandoned conversation refuses a new question", () => {
    expect(canOpenElicitation("abandoned")).toEqual({
      ok: false,
      reason: "conversation_abandoned",
    });
  });

  test("an open or committed conversation accepts a new question", () => {
    expect(canOpenElicitation("active")).toEqual({ ok: true });
    expect(canOpenElicitation("awaiting_input")).toEqual({ ok: true });
    expect(canOpenElicitation("committed")).toEqual({ ok: true });
  });
});
