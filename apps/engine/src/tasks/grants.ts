import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { connectors, taskGrants, tasks } from "../db/schema/index.ts";
import { invalidateTenantState } from "../operator/index.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import { can, connectorAccessLevel, hasBuiltinAdminRole } from "../rbac/evaluator.ts";
import { AUTHORITY_WINDOW_MAX_DAYS, windowValid } from "../workflows/core/authority.ts";
import { readDatabaseNow } from "../workflows/database-clock.ts";
import {
  GrantWorkflowAuthoritySchema,
  grantWorkflowAuthorityLocked,
  type HumanSessionProof,
  lockLiveSession,
  requireHumanSession,
} from "../workflows/execution-authorities.ts";
import { lockWorkflowForVersionWrite } from "../workflows/version-write-lock.ts";
import {
  createdAuthorityIds,
  taskGrantFailure as fail,
  type TaskAuthorityGrantInput,
  TaskAuthorityGrantInputSchema,
  type TaskAuthorityGrantResult,
  type TaskAuthorityPreview,
  type TaskAuthorityRevokeResult,
  type TaskGrantRow,
  taskGrantView,
} from "./grants/model.ts";
import { grantValidity, revokeGrantLocked } from "./grants/revocation.ts";
import { type ComparedToolPins, compareBoundToolPins } from "./grants/tool-pins.ts";
import { assessBoundWorkflow } from "./grants/workflows.ts";
import type { TaskGrant } from "./types.ts";

export interface TaskGrantHumanContext {
  request: Request;
  principal: ResolvedPrincipal;
  db: Db;
}

type TaskRow = typeof tasks.$inferSelect;
type WorkflowOutcome = TaskAuthorityGrantResult["workflows"][number];

async function visibleTask(
  db: Executor,
  principal: ResolvedPrincipal,
  task_id: string,
  lock: boolean,
): Promise<TaskRow> {
  const query = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.tenant_id, principal.tenant_id), eq(tasks.id, task_id)))
    .limit(1);
  const [task] = lock ? await query.for("update") : await query;
  if (!task || (task.owner_id !== principal.id && !hasBuiltinAdminRole(principal)))
    fail("task_not_found", "task unavailable");
  return task;
}

function boundWorkflowIds(task: TaskRow): string[] {
  return [...new Set(task.bindings.workflow_ids)].sort();
}

async function requireTaskGrantor(context: TaskGrantHumanContext, task_id: string) {
  const { db, principal } = context;
  if (principal.provider === "task" || principal.auth_source?.kind === "task_run")
    fail("human_session_required", "a signed human browser session is required");
  const session = await requireHumanSession(context);
  const permission = await can(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission: "task:grant",
    resource: { type: "task", id: task_id },
  });
  if (!permission.allow) fail("task_grant_permission_denied", "task:grant permission is required");
  return session;
}

async function unrevokedGrants(tx: Executor, task: TaskRow, lock: boolean) {
  const query = tx
    .select()
    .from(taskGrants)
    .where(
      and(
        eq(taskGrants.tenant_id, task.tenant_id),
        eq(taskGrants.task_id, task.id),
        isNull(taskGrants.revoked_at),
      ),
    )
    .orderBy(taskGrants.id);
  return lock ? query.for("update") : query;
}

export async function previewTaskGrant(
  task_id: string,
  context: { principal: ResolvedPrincipal; db: Executor },
): Promise<TaskAuthorityPreview> {
  const { principal, db } = context;
  const task = await visibleTask(db, principal, task_id, false);
  const workflows: TaskAuthorityPreview["workflows"] = [];
  for (const workflow_id of boundWorkflowIds(task))
    workflows.push(
      await assessBoundWorkflow(db, {
        principal,
        workflow_id,
        environment: task.environment,
        lock: false,
      }),
    );
  const connector_ids = [...new Set(task.bindings.connector_ids)].sort();
  const known = connector_ids.length
    ? await db
        .select({ id: connectors.id, name: connectors.display_name })
        .from(connectors)
        .where(
          and(eq(connectors.tenant_id, principal.tenant_id), inArray(connectors.id, connector_ids)),
        )
    : [];
  const names = new Map(known.map((row) => [row.id, row.name]));
  const bound: TaskAuthorityPreview["connectors"] = [];
  for (const connector_id of connector_ids) {
    const access = names.has(connector_id)
      ? await connectorAccessLevel(db, principal, connector_id, principal.tenant_id)
      : "none";
    bound.push({
      connector_id,
      name: access === "none" ? null : (names.get(connector_id) ?? null),
      access: names.has(connector_id) && task.owner_id === principal.id ? access : null,
    });
  }
  const live = (await unrevokedGrants(db, task, false)).find(
    (grant) => grant.environment === task.environment,
  );
  return {
    task_id: task.id,
    fingerprint: task.fingerprint,
    environment: task.environment,
    grantable: task.lifecycle === "active",
    schedule: {
      schedule_cron: task.schedule_cron,
      schedule_timezone: task.schedule_timezone,
      schedule_run_at: task.schedule_run_at?.toISOString() ?? null,
    },
    workflows,
    connectors: bound,
    web_search: task.bindings.web_search === true,
    workflow_run_limit_shared_with_other_triggers: true,
    live_grant: live ? taskGrantView(live) : null,
  };
}

export async function listTaskGrants(
  task_id: string,
  context: { principal: ResolvedPrincipal; db: Executor },
): Promise<TaskGrant[]> {
  const task = await visibleTask(context.db, context.principal, task_id, false);
  const rows = await context.db
    .select()
    .from(taskGrants)
    .where(and(eq(taskGrants.tenant_id, task.tenant_id), eq(taskGrants.task_id, task.id)))
    .orderBy(desc(taskGrants.created_at), desc(taskGrants.id));
  return rows.map(taskGrantView);
}

function identicalLiveGrant(
  grant: TaskGrantRow,
  task: TaskRow,
  wanted: { until: Date | null; max_runs: number | null; created_by: string; now: Date },
): boolean {
  return (
    grant.environment === task.environment &&
    grant.fingerprint === task.fingerprint &&
    grant.created_by === wanted.created_by &&
    (grant.valid_until?.getTime() ?? null) === (wanted.until?.getTime() ?? null) &&
    grant.max_runs === wanted.max_runs &&
    grant.valid_from <= wanted.now &&
    (grant.valid_until === null || grant.valid_until > wanted.now) &&
    (grant.max_runs === null || grant.reserved_runs < grant.max_runs)
  );
}

async function coGrantWorkflow(
  tx: Executor,
  input: {
    principal: ResolvedPrincipal;
    proof: HumanSessionProof;
    task: TaskRow;
    grant: TaskGrantRow;
    valid_from: Date;
    workflow_id: string;
    expected_digest: string | undefined;
    tool_pins: ComparedToolPins | undefined;
  },
): Promise<WorkflowOutcome> {
  const { principal, task, grant, workflow_id } = input;
  const assessed = await assessBoundWorkflow(tx, {
    principal,
    workflow_id,
    environment: task.environment,
    lock: true,
  });
  if (assessed.blocked_reason)
    return {
      workflow_id,
      outcome: "not_granted",
      authority_id: null,
      reason: assessed.blocked_reason,
    };
  if (assessed.covering_authority)
    return {
      workflow_id,
      outcome: "covered",
      authority_id: assessed.covering_authority.id,
      reason: null,
    };
  if (!assessed.may_grant)
    return {
      workflow_id,
      outcome: "not_granted",
      authority_id: null,
      reason: "workflow_permission_missing",
    };
  if (!input.expected_digest || input.expected_digest !== assessed.effect_manifest_digest)
    fail(
      "task_grant_preview_changed",
      "what a bound workflow may do changed since the preview; review again",
    );
  const pins = input.tool_pins?.digest === input.expected_digest ? input.tool_pins : undefined;
  if (pins?.drift)
    return {
      workflow_id,
      outcome: "not_granted",
      authority_id: null,
      reason: "workflow_not_repeatable",
    };
  const authority = await grantWorkflowAuthorityLocked(
    tx,
    input.proof,
    workflow_id,
    GrantWorkflowAuthoritySchema.parse({
      workflow_version_id: assessed.workflow_version_id,
      expected_manifest_digest: input.expected_digest,
      execution_environment: task.environment,
      valid_from: input.valid_from.toISOString(),
      valid_until: grant.valid_until?.toISOString() ?? null,
      max_runs: grant.max_runs === null ? null : grant.max_runs - grant.reserved_runs,
    }),
    principal,
    { task_grant_id: grant.id, tool_pins: pins ? "compared" : "refuse" },
  );
  return { workflow_id, outcome: "granted", authority_id: authority.id, reason: null };
}

async function grantLocked(
  tx: Executor,
  proof: HumanSessionProof,
  task_id: string,
  input: TaskAuthorityGrantInput,
  principal: ResolvedPrincipal,
  compared: ReadonlyMap<string, ComparedToolPins>,
): Promise<TaskAuthorityGrantResult> {
  const task = await visibleTask(tx, principal, task_id, true);
  if (task.lifecycle !== "active")
    fail("task_not_grantable", "an archived task cannot receive a standing permission");
  if (task.fingerprint !== input.expected_fingerprint)
    fail("task_fingerprint_changed", "the task changed since the preview; review again");
  const now = await readDatabaseNow(tx);
  const until = input.valid_until ? new Date(input.valid_until) : null;
  if (!windowValid(now, until, now))
    fail(
      "authority_window_invalid",
      `choose a non-expired authority window of at most ${AUTHORITY_WINDOW_MAX_DAYS} days`,
    );
  const workflow_ids = boundWorkflowIds(task);
  for (const workflow_id of workflow_ids)
    await lockWorkflowForVersionWrite(tx, task.tenant_id, workflow_id);
  const previous = await unrevokedGrants(tx, task, true);
  const identical = previous.find((grant) =>
    identicalLiveGrant(grant, task, {
      until,
      max_runs: input.max_runs,
      created_by: principal.id,
      now,
    }),
  );
  const superseded_grant_ids: string[] = [];
  for (const grant of previous) {
    if (grant.id === identical?.id) continue;
    await revokeGrantLocked(tx, grant, {
      kind: "human",
      principal,
      proof,
      reason_code: "superseded",
    });
    superseded_grant_ids.push(grant.id);
  }
  const [inserted] = identical
    ? [identical]
    : await tx
        .insert(taskGrants)
        .values({
          tenant_id: task.tenant_id,
          task_id: task.id,
          fingerprint: task.fingerprint,
          environment: task.environment,
          valid_from: now,
          valid_until: until,
          max_runs: input.max_runs,
          created_by: principal.id,
        })
        .returning();
  if (!inserted) throw new Error("task grant insert returned no row");
  const workflows: WorkflowOutcome[] = [];
  for (const workflow_id of workflow_ids)
    workflows.push(
      await coGrantWorkflow(tx, {
        principal,
        proof,
        task,
        grant: inserted,
        valid_from: identical ? now : inserted.valid_from,
        workflow_id,
        expected_digest: input.expected_workflow_digests[workflow_id],
        tool_pins: compared.get(workflow_id),
      }),
    );
  const minted = workflows.flatMap((workflow) =>
    workflow.outcome === "granted" && workflow.authority_id ? [workflow.authority_id] : [],
  );
  const changed = !identical || minted.length > 0 || superseded_grant_ids.length > 0;
  if (!changed) return { grant: taskGrantView(inserted), changed, superseded_grant_ids, workflows };
  const workflow_authority_ids = [...new Set([...createdAuthorityIds(inserted), ...minted])];
  const [grant] = await tx
    .update(taskGrants)
    .set({ workflow_authority_ids })
    .where(and(eq(taskGrants.tenant_id, task.tenant_id), eq(taskGrants.id, inserted.id)))
    .returning();
  if (!grant) throw new Error("task grant update returned no row");
  await auditAwait(
    {
      tenant_id: task.tenant_id,
      actor_type: "user",
      actor_id: principal.id,
      action: AuditAction.TASK_AUTHORITY_GRANTED,
      resource_type: "task_grant",
      resource_id: grant.id,
      result: "success",
      metadata: {
        ...grantValidity(grant),
        existing_grant: Boolean(identical),
        workflow_authority_ids,
        minted_workflow_authority_ids: minted,
        covered_workflow_ids: workflows
          .filter((workflow) => workflow.outcome === "covered")
          .map((workflow) => workflow.workflow_id),
        not_granted_workflows: workflows
          .filter((workflow) => workflow.outcome === "not_granted")
          .map((workflow) => ({ workflow_id: workflow.workflow_id, reason_code: workflow.reason })),
        superseded_grant_ids,
      },
    },
    tx,
  );
  await emitResourceChange(tx, {
    tenant_id: task.tenant_id,
    type: "task.grant_changed",
    ids: { task_id: task.id, task_grant_id: grant.id },
  });
  return { grant: taskGrantView(grant), changed, superseded_grant_ids, workflows };
}

export async function grantTaskAuthority(
  task_id: string,
  raw: unknown,
  context: TaskGrantHumanContext,
): Promise<TaskAuthorityGrantResult> {
  const input = TaskAuthorityGrantInputSchema.parse(raw);
  const session = await requireTaskGrantor(context, task_id);
  const { db, principal } = context;
  const reviewed = await visibleTask(db, principal, task_id, false);
  const compared =
    reviewed.lifecycle === "active" && reviewed.fingerprint === input.expected_fingerprint
      ? await compareBoundToolPins(db, {
          principal,
          environment: reviewed.environment,
          workflow_ids: boundWorkflowIds(reviewed),
          expected_workflow_digests: input.expected_workflow_digests,
        })
      : new Map<string, ComparedToolPins>();
  const result = await db.transaction(async (tx) => {
    const proof = await lockLiveSession(tx, session);
    return grantLocked(tx, proof, task_id, input, principal, compared);
  });
  if (result.changed) invalidateTenantState(principal.tenant_id);
  return result;
}

export async function revokeTaskAuthority(
  task_id: string,
  grant_id: string,
  context: TaskGrantHumanContext,
): Promise<TaskAuthorityRevokeResult> {
  const session = await requireTaskGrantor(context, task_id);
  const { db, principal } = context;
  const result = await db.transaction(async (tx) => {
    const proof = await lockLiveSession(tx, session);
    const task = await visibleTask(tx, principal, task_id, true);
    const [grant] = await tx
      .select()
      .from(taskGrants)
      .where(
        and(
          eq(taskGrants.tenant_id, task.tenant_id),
          eq(taskGrants.task_id, task.id),
          eq(taskGrants.id, grant_id),
        ),
      )
      .for("update")
      .limit(1);
    if (!grant) fail("task_grant_not_found", "standing permission unavailable");
    if (grant.revoked_at)
      return {
        grant: taskGrantView(grant),
        changed: false,
        revoked_workflow_authority_ids: [],
        transferred_workflow_authority_ids: [],
        retained_successor_authority_ids: [],
      };
    const { grant: revoked, ...release } = await revokeGrantLocked(tx, grant, {
      kind: "human",
      principal,
      proof,
      reason_code: "revoked",
    });
    return { grant: taskGrantView(revoked), changed: true, ...release };
  });
  if (result.changed) invalidateTenantState(principal.tenant_id);
  return result;
}
