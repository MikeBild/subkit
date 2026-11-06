import { and, desc, eq } from "drizzle-orm";
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

interface ExecutionSuppression {
  live: boolean;
  all: boolean;
}

interface ScannedIntent extends ExecutionSuppression {
  run_request: boolean;
}

function scan(text: string | null | undefined): ScannedIntent {
  const intent = detectUserIntent(text);
  const all = intent.suppressExecution === true;
  const live = all || intent.suppressLiveExecution === true;
  return {
    live,
    all,
    run_request:
      !live &&
      (intent.forceTool === "run_workflow" ||
        intent.requestExternalAction === true ||
        intent.requestExternalRead === true),
  };
}

const NONE: ExecutionSuppression = { live: false, all: false };

function merge(left: ExecutionSuppression, right: ExecutionSuppression): ExecutionSuppression {
  return { live: left.live || right.live, all: left.all || right.all };
}

async function userMessagesNewestFirst(input: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
}): Promise<string[]> {
  const messages = await input.db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, input.tenant_id),
        eq(conversationMessages.conversation_id, input.conversation_id),
        eq(conversationMessages.role, "user"),
      ),
    )
    .orderBy(desc(conversationMessages.created_at));
  return messages.flatMap((message) => {
    const text = messageText(message.content);
    return text === null ? [] : [text];
  });
}

export async function conversationExecutionSuppression(input: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  recent_user_message?: string | null;
}): Promise<ExecutionSuppression> {
  const recent = scan(input.recent_user_message);
  if (recent.all) return merge(NONE, recent);
  return (await userMessagesNewestFirst(input)).reduce<ExecutionSuppression>(
    (combined, text) => merge(combined, scan(text)),
    merge(NONE, recent),
  );
}

export async function turnExecutionSuppression(input: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  recent_user_message?: string | null;
}): Promise<ExecutionSuppression> {
  const recent = scan(input.recent_user_message);
  if (recent.run_request) return NONE;
  if (recent.all) return merge(NONE, recent);
  const history = await userMessagesNewestFirst(input);
  const lift = history.findIndex((text) => scan(text).run_request);
  return (lift === -1 ? history : history.slice(0, lift)).reduce<ExecutionSuppression>(
    (combined, text) => merge(combined, scan(text)),
    merge(NONE, recent),
  );
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
}): Promise<{ error_code: string; message: string; next_best_actions: string[] } | null> {
  const suppression = await turnExecutionSuppression(input);
  if (suppression.all)
    return {
      error_code: "explicit_no_run",
      message:
        "The user explicitly asked not to start a workflow run. No execution was started; use read-only execution history or diagnosis tools for existing runs.",
      next_best_actions: ["list_executions", "diagnose_latest_execution"],
    };
  if (suppression.live && input.live_tool)
    return {
      error_code: "explicit_no_live_effects",
      message:
        "The user asked not to activate anything or cause live effects. No execution was started. Inspect and review instead; a saved inactive draft can be previewed with dry_run_workflow (writes held, nothing activated).",
      next_best_actions: ["review_workflow_automation", "dry_run_workflow"],
    };
  return null;
}
