import { describe, expect, test } from "bun:test";
import { chatMessageAnchor, conversationMessageHref } from "@/app/links";
import { messageIdFromHash, tasksBySourceMessage } from "./source-tasks";

const M1 = "00000000-0000-4000-8000-000000000001";
const M2 = "00000000-0000-4000-8000-000000000002";

describe("tasks under the chat message they serve", () => {
  test("each task sits under its own message, in the order they were created", () => {
    const grouped = tasksBySourceMessage([
      { id: "t1", name: "Sort the inbox", source_message_id: M1 },
      { id: "t2", name: "Send the report", source_message_id: M2 },
      { id: "t3", name: "Archive old mail", source_message_id: M1 },
    ]);
    expect(grouped.get(M1)).toEqual([
      { id: "t1", name: "Sort the inbox" },
      { id: "t3", name: "Archive old mail" },
    ]);
    expect(grouped.get(M2)).toEqual([{ id: "t2", name: "Send the report" }]);
  });

  test("a task whose message is gone shows under no message", () => {
    expect(tasksBySourceMessage([{ id: "t1", name: "x", source_message_id: null }]).size).toBe(0);
  });

  test("the task page links to the message and the chat finds it again", () => {
    const href = conversationMessageHref("c1", M1);
    expect(href).toBe(`/chat/c1#${chatMessageAnchor(M1)}`);
    expect(messageIdFromHash(href.slice(href.indexOf("#")))).toBe(M1);
  });

  test("any other hash points at no message", () => {
    expect(messageIdFromHash("")).toBeNull();
    expect(messageIdFromHash("#chat-account-connection")).toBeNull();
    expect(messageIdFromHash("#message-not-an-id")).toBeNull();
  });
});
