import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Executor } from "../../db/client.ts";
import { taskGrants, taskRuns, tasks } from "../../db/schema/index.ts";
import { emitResourceChange } from "../../pubsub/resource-changes.ts";
import {
  type HumanSessionProof,
  revokeAuthorityMintedByTaskGrant,
  revokeWorkflowAuthorityLocked,
  type TaskGrantAuthorityRevocationReason,
  taskGrantAuthorityEnd,
} from "../../workflows/execution-authorities.ts";
import { TASK_RUN_OPEN_STATES } from "../types.ts";
import {
  createdAuthorityIds,
  type TaskAuthorityRevokeResult,
  type TaskGrantRow,
  taskGrantView,
} from "./model.ts";

export type TaskGrantLifecycleActor = { type: "system" } | { type: "user"; id: string };

export type TaskGrantRevoker =
  | {
      kind: "human";
      principal: ResolvedPrincipal;
      proof: HumanSessionProof;
      reason_code: "revoked" | "superseded";
    }
  | {
      kind: "lifecycle";
      actor: TaskGrantLifecycleActor;
      reason_code: TaskGrantAuthorityRevocationReason;
    };

export interface AuthorityRelease {
  revoked_workflow_authority_ids: string[];
  transferred_workflow_authority_ids: string[];
  retained_successor_authority_ids: string[];
}

export function grantValidity(row: TaskGrantRow) {
  return {
    task_id: row.task_id,
    task_grant_id: row.id,
    fingerprint: row.fingerprint,
    execution_environment: row.environment,
    valid_from: row.valid_from.toISOString(),
    valid_until: row.valid_until?.toISOString() ?? null,
    max_runs: row.max_runs,
    open_ended: row.valid_until === null && row.max_runs === null,
  };
}

function auditActor(revoker: TaskGrantRevoker) {
  if (revoker.kind === "human")
    return { actor_type: "user" as const, actor_id: revoker.principal.id };
  return revoker.actor.type === "user"
    ? { actor_type: "user" as const, actor_id: revoker.actor.id }
    : { actor_type: "system" as const, actor_id: null };
}

function revokedBy(revoker: TaskGrantRevoker, grant: TaskGrantRow): string {
  if (revoker.kind === "human") return revoker.principal.id;
  return revoker.actor.type === "user" ? revoker.actor.id : grant.created_by;
}

async function heirGrantId(
  tx: Executor,
  grant: TaskGrantRow,
  authority: { workflow_id: string; execution_environment: "dev" | "prod" },
): Promise<string | null> {
  const [heir] = await tx
    .select({ id: taskGrants.id })
    .from(taskGrants)
    .innerJoin(
      tasks,
      and(
        eq(tasks.tenant_id, taskGrants.tenant_id),
        eq(tasks.id, taskGrants.task_id),
        eq(tasks.fingerprint, taskGrants.fingerprint),
        eq(tasks.environment, taskGrants.environment),
        eq(tasks.lifecycle, "active"),
      ),
    )
    .where(
      and(
        eq(taskGrants.tenant_id, grant.tenant_id),
        ne(taskGrants.id, grant.id),
        ne(taskGrants.task_id, grant.task_id),
        isNull(taskGrants.revoked_at),
        eq(taskGrants.environment, authority.execution_environment),
        sql`${taskGrants.valid_from} <= clock_timestamp()`,
        sql`(${taskGrants.valid_until} IS NULL OR ${taskGrants.valid_until} > clock_timestamp())`,
        sql`(${taskGrants.max_runs} IS NULL OR ${taskGrants.reserved_runs} < ${taskGrants.max_runs})`,
        sql`${tasks.bindings} -> 'workflow_ids' @> ${JSON.stringify([authority.workflow_id])}::jsonb`,
      ),
    )
    .orderBy(taskGrants.id)
    .limit(1)
    .for("update", { of: taskGrants, skipLocked: true });
  return heir?.id ?? null;
}

async function handOver(
  tx: Executor,
  grant: TaskGrantRow,
  heir_id: string,
  origin_authority_id: string,
  authority_id: string,
) {
  const tenant_id = grant.tenant_id;
  const member = JSON.stringify([authority_id]);
  await tx
    .update(taskGrants)
    .set({
      workflow_authority_ids: sql`${taskGrants.workflow_authority_ids} - ${origin_authority_id}::text`,
    })
    .where(and(eq(taskGrants.tenant_id, tenant_id), eq(taskGrants.id, grant.id)));
  await tx
    .update(taskGrants)
    .set({
      workflow_authority_ids: sql`${taskGrants.workflow_authority_ids} || ${member}::jsonb`,
    })
    .where(
      and(
        eq(taskGrants.tenant_id, tenant_id),
        eq(taskGrants.id, heir_id),
        sql`NOT (${taskGrants.workflow_authority_ids} @> ${member}::jsonb)`,
      ),
    );
  await emitResourceChange(tx, {
    tenant_id,
    type: "task.grant_changed",
    ids: { task_grant_id: heir_id },
  });
}

async function releaseAuthorities(
  tx: Executor,
  grant: TaskGrantRow,
  revoker: TaskGrantRevoker,
): Promise<AuthorityRelease> {
  const release: AuthorityRelease = {
    revoked_workflow_authority_ids: [],
    transferred_workflow_authority_ids: [],
    retained_successor_authority_ids: [],
  };
  for (const origin_authority_id of createdAuthorityIds(grant)) {
    const end = await taskGrantAuthorityEnd(tx, grant.tenant_id, origin_authority_id);
    if (end.retained_successor_authority_id)
      release.retained_successor_authority_ids.push(end.retained_successor_authority_id);
    const live = end.live;
    if (!live) continue;
    const heir_id = await heirGrantId(tx, grant, live);
    if (heir_id) {
      await handOver(tx, grant, heir_id, origin_authority_id, live.id);
      release.transferred_workflow_authority_ids.push(live.id);
      continue;
    }
    if (revoker.kind === "human")
      await revokeWorkflowAuthorityLocked(
        tx,
        revoker.proof,
        live.workflow_id,
        live.id,
        revoker.principal,
        { task_grant_id: grant.id, reason_code: revoker.reason_code },
      );
    else
      await revokeAuthorityMintedByTaskGrant(tx, {
        tenant_id: grant.tenant_id,
        task_grant_id: grant.id,
        origin_authority_id,
        reason_code: revoker.reason_code,
        actor: revoker.actor,
      });
    release.revoked_workflow_authority_ids.push(live.id);
  }
  return release;
}

async function recordRelease(
  tx: Executor,
  grant: TaskGrantRow,
  revoker: TaskGrantRevoker,
  release: AuthorityRelease,
) {
  await auditAwait(
    {
      tenant_id: grant.tenant_id,
      ...auditActor(revoker),
      action: AuditAction.TASK_AUTHORITY_REVOKED,
      resource_type: "task_grant",
      resource_id: grant.id,
      result: "success",
      metadata: {
        ...grantValidity(grant),
        reserved_runs: grant.reserved_runs,
        reason_code: revoker.reason_code,
        ...release,
      },
    },
    tx,
  );
  await emitResourceChange(tx, {
    tenant_id: grant.tenant_id,
    type: "task.grant_changed",
    ids: { task_id: grant.task_id, task_grant_id: grant.id },
  });
}

export async function revokeGrantLocked(
  tx: Executor,
  grant: TaskGrantRow,
  revoker: TaskGrantRevoker,
): Promise<{ grant: TaskGrantRow } & AuthorityRelease> {
  const [revoked] = await tx
    .update(taskGrants)
    .set({ revoked_at: sql`clock_timestamp()`, revoked_by: revokedBy(revoker, grant) })
    .where(
      and(
        eq(taskGrants.tenant_id, grant.tenant_id),
        eq(taskGrants.id, grant.id),
        isNull(taskGrants.revoked_at),
      ),
    )
    .returning();
  if (!revoked) throw new Error("task grant revocation returned no row");
  const release = await releaseAuthorities(tx, revoked, revoker);
  await recordRelease(tx, revoked, revoker, release);
  const [current] = await tx
    .select()
    .from(taskGrants)
    .where(and(eq(taskGrants.tenant_id, grant.tenant_id), eq(taskGrants.id, grant.id)))
    .limit(1);
  return { grant: current ?? revoked, ...release };
}

async function hasOpenRun(tx: Executor, grant: TaskGrantRow): Promise<boolean> {
  const [open] = await tx
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.tenant_id, grant.tenant_id),
        eq(taskRuns.grant_id, grant.id),
        inArray(taskRuns.state, [...TASK_RUN_OPEN_STATES, "result_ready"]),
      ),
    )
    .limit(1);
  return Boolean(open);
}

async function exhaustedAndIdle(tx: Executor, grant: TaskGrantRow): Promise<boolean> {
  if (grant.max_runs === null || grant.reserved_runs < grant.max_runs) return false;
  return !(await hasOpenRun(tx, grant));
}

export async function revokeTaskGrantsForTaskLocked(
  tx: Executor,
  task: { tenant_id: string; task_id: string },
  actor: TaskGrantLifecycleActor,
  reason_code: TaskGrantAuthorityRevocationReason,
): Promise<TaskAuthorityRevokeResult[]> {
  const grants = await tx
    .select()
    .from(taskGrants)
    .where(
      and(
        eq(taskGrants.tenant_id, task.tenant_id),
        eq(taskGrants.task_id, task.task_id),
        isNull(taskGrants.revoked_at),
      ),
    )
    .orderBy(taskGrants.id)
    .for("update");
  const results: TaskAuthorityRevokeResult[] = [];
  for (const grant of grants) {
    if (reason_code === "grant_exhausted" && !(await exhaustedAndIdle(tx, grant))) continue;
    const { grant: revoked, ...release } = await revokeGrantLocked(tx, grant, {
      kind: "lifecycle",
      actor,
      reason_code,
    });
    results.push({ grant: taskGrantView(revoked), changed: true, ...release });
  }
  return results;
}
