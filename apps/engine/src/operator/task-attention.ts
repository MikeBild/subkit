import { and, asc, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import {
  conversationHidden,
  conversations,
  taskGrants,
  taskRuns,
  tasks,
} from "../db/schema/index.ts";
import { hasBuiltinAdminRole } from "../rbac/evaluator.ts";
import { isTaskGrantExpiringSoon, taskGrantStatus } from "../tasks/core/grant.ts";
import { nextTaskStart } from "../tasks/core/schedule.ts";
import type { Candidate } from "./attention-readers.ts";
import type {
  AttentionAction,
  AttentionClass,
  AttentionReason,
  AttentionSeverity,
} from "./core/attention.ts";

export interface TaskAttentionScope {
  tenant_id: string;
  owner_id: string | null;
  viewer_id: string;
}

export function taskAttentionScope(principal: ResolvedPrincipal): TaskAttentionScope {
  return {
    tenant_id: principal.tenant_id,
    owner_id: hasBuiltinAdminRole(principal) ? null : principal.id,
    viewer_id: principal.id,
  };
}

export type TaskAttentionReader = (
  db: Db,
  scope: TaskAttentionScope,
  now: Date,
) => Promise<Candidate[]>;

export const TASK_ATTENTION_LIMIT = 500;

export function taskAttentionHref(taskId: string): string {
  return `/cockpit/tasks/${encodeURIComponent(taskId)}`;
}

interface TaskRow {
  id: string;
  name: string;
  environment: "dev" | "prod";
  fingerprint: string;
  schedule_cron: string | null;
  schedule_timezone: string | null;
  schedule_run_at: Date | null;
  last_claimed_at: Date | null;
  paused_at: Date | null;
  paused_reason: "owner_request" | "admin" | "owner_unavailable" | null;
}

interface Finding {
  reason: AttentionReason;
  class: AttentionClass;
  severity: AttentionSeverity;
  verb: AttentionAction["verb"];
  permission: string;
  since: Date | null;
  deadline: Date | null;
  detail: string | null;
}

const GRANT_REFUSALS: Record<string, string> = {
  fingerprint_mismatch: "grant_fingerprint_mismatch",
  expired: "grant_expired",
  exhausted: "grant_exhausted",
};

function candidateOf(task: TaskRow, finding: Finding): Candidate {
  return {
    source: "tasks",
    resource: { type: "task", id: task.id },
    item: {
      id: `task:${task.id}`,
      class: finding.class,
      severity: finding.severity,
      kind: "task",
      subject: { kind: "task", id: task.id, name: task.name, environment: task.environment },
      reason: finding.reason,
      trigger: null,
      cause_class: null,
      counts: {},
      since: finding.since?.toISOString() ?? null,
      deadline: finding.deadline?.toISOString() ?? null,
      detail: finding.detail,
      actions: [
        {
          verb: finding.verb,
          href: taskAttentionHref(task.id),
          primary: true,
          permission: finding.permission,
        },
      ],
    },
  };
}

export const readTaskAttention: TaskAttentionReader = async (db, scope, now) => {
  const visible: TaskRow[] = await db
    .select({
      id: tasks.id,
      name: tasks.name,
      environment: tasks.environment,
      fingerprint: tasks.fingerprint,
      schedule_cron: tasks.schedule_cron,
      schedule_timezone: tasks.schedule_timezone,
      schedule_run_at: tasks.schedule_run_at,
      last_claimed_at: tasks.last_claimed_at,
      paused_at: tasks.paused_at,
      paused_reason: tasks.paused_reason,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenant_id, scope.tenant_id),
        eq(tasks.lifecycle, "active"),
        ...(scope.owner_id === null ? [] : [eq(tasks.owner_id, scope.owner_id)]),
      ),
    )
    .orderBy(asc(tasks.created_at), asc(tasks.id))
    .limit(TASK_ATTENTION_LIMIT);
  if (visible.length === 0) return [];
  const ids = visible.map((task) => task.id);

  const [latestRuns, readyRuns, grants] = await Promise.all([
    db
      .selectDistinctOn([taskRuns.task_id], {
        task_id: taskRuns.task_id,
        state: taskRuns.state,
        waiting_reason: taskRuns.waiting_reason,
        failure_code: taskRuns.failure_code,
        conversation_id: taskRuns.conversation_id,
        ended_at: taskRuns.ended_at,
        updated_at: taskRuns.updated_at,
      })
      .from(taskRuns)
      .where(and(eq(taskRuns.tenant_id, scope.tenant_id), inArray(taskRuns.task_id, ids)))
      .orderBy(taskRuns.task_id, desc(taskRuns.created_at), desc(taskRuns.id)),
    db
      .selectDistinctOn([taskRuns.task_id], {
        task_id: taskRuns.task_id,
        result_ready_at: taskRuns.result_ready_at,
        updated_at: taskRuns.updated_at,
      })
      .from(taskRuns)
      .where(
        and(
          eq(taskRuns.tenant_id, scope.tenant_id),
          inArray(taskRuns.task_id, ids),
          eq(taskRuns.state, "result_ready"),
        ),
      )
      .orderBy(taskRuns.task_id, desc(taskRuns.created_at), desc(taskRuns.id)),
    db
      .select({
        task_id: taskGrants.task_id,
        environment: taskGrants.environment,
        fingerprint: taskGrants.fingerprint,
        valid_from: taskGrants.valid_from,
        valid_until: taskGrants.valid_until,
        max_runs: taskGrants.max_runs,
        reserved_runs: taskGrants.reserved_runs,
        revoked_at: taskGrants.revoked_at,
      })
      .from(taskGrants)
      .where(
        and(
          eq(taskGrants.tenant_id, scope.tenant_id),
          inArray(taskGrants.task_id, ids),
          isNull(taskGrants.revoked_at),
        ),
      ),
  ]);

  const waitingConversations = latestRuns.flatMap((run) =>
    run.state === "waiting" && run.conversation_id ? [run.conversation_id] : [],
  );
  const surfaced =
    waitingConversations.length === 0
      ? []
      : await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenant_id, scope.tenant_id),
              inArray(conversations.id, waitingConversations),
              eq(conversations.owner_id, scope.viewer_id),
              eq(conversations.status, "awaiting_input"),
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(conversationHidden)
                  .where(
                    and(
                      eq(conversationHidden.tenant_id, scope.tenant_id),
                      eq(conversationHidden.conversation_id, conversations.id),
                      eq(conversationHidden.user_id, scope.viewer_id),
                    ),
                  ),
              ),
            ),
          );
  const surfacedIds = new Set(surfaced.map((row) => row.id));
  const latestByTask = new Map(latestRuns.map((run) => [run.task_id, run]));
  const readyByTask = new Map(readyRuns.map((run) => [run.task_id, run]));

  const candidates: Candidate[] = [];
  for (const task of visible) {
    const latest = latestByTask.get(task.id);
    const ready = readyByTask.get(task.id);
    const grant =
      grants.find((row) => row.task_id === task.id && row.environment === task.environment) ?? null;
    const nextStart =
      task.paused_at === null
        ? nextTaskStart(
            {
              schedule_cron: task.schedule_cron,
              schedule_timezone: task.schedule_timezone,
              schedule_run_at: task.schedule_run_at?.toISOString() ?? null,
            },
            { last_claimed_at: task.last_claimed_at, anchor: now },
          )
        : null;
    const grantStatus = grant ? taskGrantStatus(grant, task.fingerprint, now) : null;

    let finding: Finding | null = null;
    if (
      latest?.state === "waiting" &&
      !(latest.conversation_id && surfacedIds.has(latest.conversation_id))
    ) {
      finding = {
        reason: "awaiting_answer",
        class: "stopped",
        severity: "urgent",
        verb: "answer",
        permission: "conversation:write",
        since: latest.updated_at,
        deadline: null,
        detail: latest.waiting_reason,
      };
    } else if (
      scope.owner_id === null &&
      task.paused_at !== null &&
      task.paused_reason === "owner_unavailable"
    ) {
      finding = {
        reason: "task_owner_unavailable",
        class: "stopped",
        severity: "urgent",
        verb: "open",
        permission: "task:resume",
        since: task.paused_at,
        deadline: null,
        detail: "owner_unavailable",
      };
    } else if (latest?.state === "failed") {
      finding = {
        reason: "task_run_failed",
        class: "failing",
        severity: "urgent",
        verb: "open",
        permission: "task:read",
        since: latest.ended_at ?? latest.updated_at,
        deadline: null,
        detail: latest.failure_code,
      };
    } else if (nextStart !== null && grantStatus !== "live") {
      finding = {
        reason: "task_grant_required",
        class: "decide",
        severity: "urgent",
        verb: "open",
        permission: "task:grant",
        since: null,
        deadline: nextStart,
        detail: (grantStatus && GRANT_REFUSALS[grantStatus]) || "grant_required",
      };
    } else if (ready) {
      finding = {
        reason: "task_result_ready",
        class: "decide",
        severity: "notice",
        verb: "review",
        permission: "task:run",
        since: ready.result_ready_at ?? ready.updated_at,
        deadline: null,
        detail: null,
      };
    } else if (
      nextStart !== null &&
      grant &&
      isTaskGrantExpiringSoon(grant, task.fingerprint, now)
    ) {
      finding = {
        reason: "task_grant_expiring",
        class: "decide",
        severity: "notice",
        verb: "renew",
        permission: "task:grant",
        since: null,
        deadline: grant.valid_until,
        detail: null,
      };
    }
    if (finding) candidates.push(candidateOf(task, finding));
  }
  return candidates;
};

export async function retargetRunConversations(
  db: Db,
  tenant_id: string,
  candidates: readonly Candidate[],
): Promise<Candidate[]> {
  const conversationIds = candidates.flatMap((candidate) =>
    candidate.resource?.type === "conversation" ? [candidate.resource.id] : [],
  );
  if (conversationIds.length === 0) return [...candidates];
  const runs = await db
    .select({ conversation_id: taskRuns.conversation_id, task_id: taskRuns.task_id })
    .from(taskRuns)
    .where(
      and(eq(taskRuns.tenant_id, tenant_id), inArray(taskRuns.conversation_id, conversationIds)),
    );
  const taskByConversation = new Map(runs.map((run) => [run.conversation_id, run.task_id]));
  return candidates.map((candidate) => {
    const taskId =
      candidate.resource?.type === "conversation"
        ? taskByConversation.get(candidate.resource.id)
        : undefined;
    if (!taskId) return candidate;
    return {
      ...candidate,
      item: {
        ...candidate.item,
        actions: candidate.item.actions.map((action) => ({
          ...action,
          href: taskAttentionHref(taskId),
        })),
      },
    };
  });
}
