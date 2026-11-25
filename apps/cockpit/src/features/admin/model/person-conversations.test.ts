import { describe, expect, test } from "bun:test";
import { mayDeletePersonConversations, personConversationRow } from "./person-conversations";

const labels = { hidden: "Private conversation", untitled: "Untitled" };

describe("person conversations", () => {
  test("a private conversation of someone else shows only that it exists", () => {
    expect(
      personConversationRow(
        { id: "a", title: null, content_hidden: true, updated_at: "2026-11-25T08:00:00Z" },
        labels,
      ),
    ).toEqual({
      id: "a",
      hidden: true,
      title: "Private conversation",
      updated_at: "2026-11-25T08:00:00Z",
    });
  });

  test("a shared conversation keeps its title, an empty one reads as untitled", () => {
    const at = "2026-11-25T08:00:00Z";
    expect(personConversationRow({ id: "b", title: "Q4", updated_at: at }, labels).title).toBe(
      "Q4",
    );
    expect(personConversationRow({ id: "c", title: "  ", updated_at: at }, labels).title).toBe(
      "Untitled",
    );
  });

  test("deleting needs people management and conversation write", () => {
    expect(mayDeletePersonConversations(["identity:write", "conversation:write"])).toBe(true);
    expect(mayDeletePersonConversations(["identity:write"])).toBe(false);
    expect(mayDeletePersonConversations(["conversation:write", "identity:read"])).toBe(false);
  });
});
