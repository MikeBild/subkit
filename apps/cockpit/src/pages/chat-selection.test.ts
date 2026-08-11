import { describe, expect, test } from "bun:test";
import { activeConversationId } from "./chat-selection";

describe("chat conversation selection", () => {
  test("does not fall back to history while creating a conversation", () => {
    expect(activeConversationId({ kind: "new" }, "existing-conversation")).toBeNull();
  });

  test("selects history only in automatic mode", () => {
    expect(activeConversationId({ kind: "automatic" }, "existing-conversation")).toBe(
      "existing-conversation",
    );
  });
});
