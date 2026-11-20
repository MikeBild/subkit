import { type SQL, sql } from "drizzle-orm";
import { conversations } from "./schema/index.ts";

export type TaskRunConversationFilter = "exclude" | "only" | "all";

export function isTaskRunConversation(): SQL<boolean> {
  return sql<boolean>`coalesce(jsonb_typeof(${conversations.draft} -> 'session') = 'object' and jsonb_exists(${conversations.draft} -> 'session', 'task_run'), false)`;
}

export function notTaskRunConversation(): SQL<boolean> {
  return sql<boolean>`not ${isTaskRunConversation()}`;
}

export function taskRunConversationCond(
  filter: TaskRunConversationFilter | undefined,
): SQL<boolean> | null {
  if (filter === "all") return null;
  return filter === "only" ? isTaskRunConversation() : notTaskRunConversation();
}
