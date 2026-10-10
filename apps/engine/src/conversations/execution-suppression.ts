import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversationMessages } from "../db/schema/index.ts";
import { detectUserIntent } from "./intent-detector.ts";

function messageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return null;
}

export async function conversationExecutionSuppressed(input: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  recent_user_message?: string | null;
}): Promise<boolean> {
  if (detectUserIntent(input.recent_user_message).suppressExecution === true) return true;
  const messages = await input.db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, input.tenant_id),
        eq(conversationMessages.conversation_id, input.conversation_id),
        eq(conversationMessages.role, "user"),
      ),
    );
  return messages.some((message) => {
    const text = messageText(message.content);
    return text !== null && detectUserIntent(text).suppressExecution === true;
  });
}
