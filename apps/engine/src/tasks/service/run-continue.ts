import { AuditAction } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { Db, Executor } from "../../db/index.ts";
import {
  decideTaskRunContinuation,
  type TaskRunContinuationRefusal,
  taskRunReattachment,
  taskRunStillHeldBy,
} from "../core/run-continue.ts";
import { decideTaskRunResume, taskRunIsOpen } from "../core/run-state.ts";
import {
  conversationPlaybookRevision,
  unattachedRunConversationIds,
} from "../persistence/run-start-rows.ts";
import type { TaskRun } from "../types.ts";
import { lockRun, runEndedAtItsLimit, type TaskRunSource, writeRun } from "./run-rows.ts";
import { type Admitted, prepareRunConversation } from "./run-start.ts";
import { endOutdatedRun } from "./runs.ts";
import {
  actorOf,
  readCarriedRunPlan,
  rowToTaskRun,
  SYSTEM_ACTOR,
  SYSTEM_SCOPE,
  type TaskEffects,
  type TaskRunRow,
  type TaskServiceDeps,
  taskServiceDeps,
  withTaskEffects,
} from "./shared.ts";

export type TaskRunContinuation =
  | { continued: true; run: TaskRun }
  | { continued: false; reason: TaskRunContinuationRefusal }
  | { continued: false; reason: "run_ended"; run: TaskRun };

export interface ContinueTaskRunParams {
  tenant_id: string;
  principal: ResolvedPrincipal;
  task_run_id: string;
  source?: TaskRunSource;
}

type Checked =
  | {
      ok: true;
      admitted: Admitted;
      previous_conversation_id: string;
      no_progress_count: number;
    }
  | { ok: false; outcome: TaskRunContinuation };

function refused(reason: TaskRunContinuationRefusal): Checked {
  return { ok: false, outcome: { continued: false, reason } };
}

function ended(run: TaskRunRow): Checked {
  return { ok: false, outcome: { continued: false, reason: "run_ended", run: rowToTaskRun(run) } };
}

async function checkContinuation(
  tx: Executor,
  deps: TaskServiceDeps,
  p: ContinueTaskRunParams,
  effects: TaskEffects,
): Promise<Checked> {
  const { run, task } = await lockRun(tx, p, p.task_run_id);
  const admission = decideTaskRunContinuation({
    run,
    owner_id: task.owner_id,
    person_id: p.principal.id,
    task_paused: task.paused_at !== null,
  });
  if (!admission.ok && admission.reason !== "paused") return refused(admission.reason);
  const outdated = await endOutdatedRun(tx, deps, run, task, effects, p.source);
  if (outdated) return ended(outdated);
  if (!admission.ok) return refused(admission.reason);
  const previous_conversation_id = run.conversation_id;
  if (!previous_conversation_id) return refused("not_held");
  const at = deps.now();
  const decision = decideTaskRunResume(run, { max_turns: task.max_turns }, at);
  if (!decision.resume) {
    const limit = runEndedAtItsLimit(decision.failure_code, at);
    return ended(
      await writeRun(tx, deps, run, limit.set, {
        at,
        effects,
        source: p.source,
        audits: [limit.audit],
      }),
    );
  }
  return {
    ok: true,
    admitted: { task, run, owner: await deps.loadOwner(tx, p.tenant_id, task.owner_id) },
    previous_conversation_id,
    no_progress_count: decision.no_progress_count,
  };
}

async function attachNewConversation(
  db: Db,
  deps: TaskServiceDeps,
  p: ContinueTaskRunParams,
  checked: Extract<Checked, { ok: true }>,
  conversation_id: string,
): Promise<TaskRunContinuation> {
  return await withTaskEffects(db, async (tx, effects) => {
    const { run } = await lockRun(
      tx,
      { tenant_id: p.tenant_id, principal: SYSTEM_SCOPE },
      p.task_run_id,
    );
    if (!taskRunStillHeldBy(run, checked.previous_conversation_id)) {
      effects.after.push((plain) =>
        deps.cancelRunConversation(plain, {
          tenant_id: p.tenant_id,
          conversation_id,
          actor: SYSTEM_ACTOR,
        }),
      );
      return taskRunIsOpen(run.state)
        ? { continued: false, reason: "not_held" }
        : { continued: false, reason: "run_ended", run: rowToTaskRun(run) };
    }
    const revision = await conversationPlaybookRevision(tx, {
      tenant_id: p.tenant_id,
      conversation_id,
    });
    const at = deps.now();
    const continued = await writeRun(
      tx,
      deps,
      run,
      taskRunReattachment({
        conversation_id,
        playbook_revision: revision ?? 0,
        no_progress_count: checked.no_progress_count,
      }),
      {
        at,
        effects,
        source: p.source,
        audits: [
          {
            action: AuditAction.TASK_RUN_RESUMED,
            actor: actorOf(p.principal),
            conversation_change: {
              previous_conversation_id: checked.previous_conversation_id,
              conversation_id,
            },
          },
        ],
      },
    );
    return { continued: true, run: rowToTaskRun(continued) };
  });
}

async function withdrawUnattachedConversations(
  db: Db,
  deps: TaskServiceDeps,
  run: { tenant_id: string; id: string },
): Promise<void> {
  const unattached = await unattachedRunConversationIds(db, run);
  for (const conversation_id of unattached)
    await deps.cancelRunConversation(db, {
      tenant_id: run.tenant_id,
      conversation_id,
      actor: SYSTEM_ACTOR,
    });
}

export async function continueTaskRunInNewConversation(
  p: ContinueTaskRunParams,
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<TaskRunContinuation> {
  const deps = taskServiceDeps(overrides);
  const checked = await withTaskEffects(db, (tx, effects) =>
    checkContinuation(tx, deps, p, effects),
  );
  if (!checked.ok) return checked.outcome;
  const carried = await readCarriedRunPlan(db, {
    tenant_id: p.tenant_id,
    conversation_id: checked.previous_conversation_id,
  });
  let conversation_id: string;
  try {
    conversation_id = await prepareRunConversation(db, deps, checked.admitted, carried);
  } catch (error) {
    await withdrawUnattachedConversations(db, deps, checked.admitted.run);
    throw error;
  }
  return await attachNewConversation(db, deps, p, checked, conversation_id);
}
