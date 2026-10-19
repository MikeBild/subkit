import { expect, test } from "bun:test";
import { isConversationToolName } from "./conversations.ts";

test("MCP routing recognizes every advertised conversation tool name", () => {
  expect(isConversationToolName("conversation_get")).toBe(true);
  expect(isConversationToolName("suggest_related_conversations")).toBe(true);
  expect(isConversationToolName("unknown_tool")).toBe(false);
});
