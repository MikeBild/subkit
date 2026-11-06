import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { conversationToolCalls } from "../../db/schema/index.ts";
import type { RecentToolCallRow } from "./prior-failures.ts";

const CRITIC_REVIEWED_TOOLS = ["author_workflow", "edit_workflow_patch"] as const;

const CRITIC_STREAK_WINDOW = 32;

const REVIEWED_TOOL_SET = new Set<string>(CRITIC_REVIEWED_TOOLS);

export function consecutiveCriticRejectionsFromRows(
  rows: ReadonlyArray<RecentToolCallRow>,
): number {
  let streak = 0;
  for (const row of rows) {
    if (!REVIEWED_TOOL_SET.has(row.tool)) continue;
    const out = row.output as Record<string, unknown> | null;
    if (!out || typeof out !== "object") continue;
    if (out.critic_rejection !== undefined) {
      streak += 1;
      continue;
    }
    const critic = out.critic as { result?: unknown } | undefined;
    if (critic && typeof critic === "object" && critic.result === "fail_open") continue;
    if (out.ok === false || typeof out.error_code === "string") continue;
    break;
  }
  return streak;
}

interface CriticStreakScope {
  db: Executor;
  tenant_id: string;
  conversation_id: string;
  tool_call_id?: string;
}

export async function loadConsecutiveCriticRejections(scope: CriticStreakScope): Promise<number> {
  const rows = await scope.db
    .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, scope.tenant_id),
        eq(conversationToolCalls.conversation_id, scope.conversation_id),
        inArray(conversationToolCalls.tool, [...CRITIC_REVIEWED_TOOLS]),
        isNotNull(conversationToolCalls.output),
        ...(scope.tool_call_id ? [ne(conversationToolCalls.id, scope.tool_call_id)] : []),
      ),
    )
    .orderBy(desc(conversationToolCalls.created_at), desc(conversationToolCalls.id))
    .limit(CRITIC_STREAK_WINDOW);
  return consecutiveCriticRejectionsFromRows(rows);
}
