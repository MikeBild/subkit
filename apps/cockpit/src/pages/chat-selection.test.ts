import { describe, expect, test } from "bun:test";
import { activeConversationId, pinSelectionForSend } from "./chat-selection";

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

describe("where a send goes", () => {
  test("a new conversation is created, whatever the list holds", () => {
    expect(pinSelectionForSend({ kind: "new" }, "awaiting-conversation")).toEqual({ kind: "new" });
  });

  test("an automatic page is pinned at send time, so a list arriving later cannot retarget it", () => {
    expect(pinSelectionForSend({ kind: "automatic" }, null)).toEqual({ kind: "new" });
    expect(pinSelectionForSend({ kind: "automatic" }, "c1")).toEqual({
      kind: "existing",
      id: "c1",
    });
  });

  test("an opened conversation stays the target", () => {
    expect(pinSelectionForSend({ kind: "existing", id: "c2" }, "c1")).toEqual({
      kind: "existing",
      id: "c2",
    });
  });
});
