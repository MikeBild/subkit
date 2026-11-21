import { and, eq } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { taskRuns } from "../../db/schema/index.ts";
import { conversationSpendUsd, spendVerdict } from "../../llm/accounting/spend.ts";
import { runNoticeDue } from "../../llm/core/spend-budget.ts";
import { MODEL_PRICE_CATALOG_CURRENCY } from "../../llm/model-price-catalog.ts";
import type { TurnUsage } from "../types.ts";

interface SpendScope {
  db: Executor;
  tenant_id: string;
  conversation_id: string;
}

export function conversationSpendBefore(p: SpendScope): Promise<number | null> {
  return conversationSpendUsd(p.db, p.tenant_id, p.conversation_id).catch(() => null);
}

async function belongsToTaskRun(p: SpendScope): Promise<boolean> {
  const [row] = await p.db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(
      and(eq(taskRuns.tenant_id, p.tenant_id), eq(taskRuns.conversation_id, p.conversation_id)),
    )
    .limit(1);
  return row !== undefined;
}

export async function turnSpendNotice(
  p: SpendScope,
  before: number | null,
): Promise<TurnUsage["spend_notice"] | null> {
  if (before === null) return null;
  try {
    const after = await conversationSpendUsd(p.db, p.tenant_id, p.conversation_id);
    if (after === null) return null;
    const run = (await belongsToTaskRun(p)) ? "task_run" : "chat_turn";
    const due = runNoticeDue({ run, before_usd: before, after_usd: after });
    return due ? { run, ...due, currency: MODEL_PRICE_CATALOG_CURRENCY } : null;
  } catch {
    return null;
  }
}

export async function spendAllowsSuggestion(p: SpendScope): Promise<boolean> {
  const verdict = await spendVerdict(
    p.tenant_id,
    { kind: "turn_helper", helper: "suggest_next" },
    p.db,
  ).catch(() => ({ ok: true }) as const);
  return verdict.ok;
}
