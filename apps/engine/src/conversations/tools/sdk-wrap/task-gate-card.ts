import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Executor } from "../../../db/client.ts";
import { abortTaskRunCard, runTaskCard, saveTaskCard } from "../../task-tool-cards.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CARDS = {
  run_task: runTaskCard,
  abort_task_run: abortTaskRunCard,
  save_task: saveTaskCard,
} as const;

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

export async function taskGateCard(
  tool: string,
  args: Record<string, unknown>,
  tenant_id: string,
  db: Executor,
  principal: ResolvedPrincipal | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (!Object.hasOwn(CARDS, tool)) return null;
  const card = CARDS[tool as keyof typeof CARDS];
  if (!principal || principal.tenant_id !== tenant_id) return card(args);
  const { getTask, getTaskRun } = await import("../../../tasks/index.ts");
  const scope = { tenant_id, principal };
  const run_id = tool === "abort_task_run" ? uuid(args.task_run_id) : null;
  const run = run_id ? await getTaskRun({ ...scope, task_run_id: run_id }, db) : null;
  const task_id = run?.task_id ?? (tool === "abort_task_run" ? null : uuid(args.task_id));
  const task = task_id ? await getTask({ ...scope, task_id, include_archived: true }, db) : null;
  return card(args, task?.name ?? null);
}
