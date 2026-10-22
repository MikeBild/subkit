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

export interface ExecutionSuppression {
  live: boolean;
  all: boolean;
}

function suppressionOf(text: string | null | undefined): ExecutionSuppression {
  const intent = detectUserIntent(text);
  const all = intent.suppressExecution === true;
  return { live: all || intent.suppressLiveExecution === true, all };
}

export async function conversationExecutionSuppression(input: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  recent_user_message?: string | null;
}): Promise<ExecutionSuppression> {
  const recent = suppressionOf(input.recent_user_message);
  if (recent.all) return recent;
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
  return messages.reduce<ExecutionSuppression>((combined, message) => {
    const text = messageText(message.content);
    if (text === null) return combined;
    const found = suppressionOf(text);
    return { live: combined.live || found.live, all: combined.all || found.all };
  }, recent);
}

export async function conversationExecutionSuppressed(input: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  recent_user_message?: string | null;
}): Promise<boolean> {
  return (await conversationExecutionSuppression(input)).all;
}

export async function executionSuppressionRefusal(input: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  recent_user_message?: string | null;
  live_tool: boolean;
}): Promise<{ error_code: string; message: string } | null> {
  const suppression = await conversationExecutionSuppression(input);
  if (suppression.all)
    return {
      error_code: "explicit_no_run",
      message:
        "The user explicitly asked not to start a workflow run. No execution was started; use read-only execution history or diagnosis tools for existing runs.",
    };
  if (suppression.live && input.live_tool)
    return {
      error_code: "explicit_no_live_effects",
      message:
        "The user asked not to activate anything or cause live effects. No execution was started. Inspect and review instead; a saved inactive draft can be previewed with dry_run_workflow (writes held, nothing activated).",
    };
  return null;
}
