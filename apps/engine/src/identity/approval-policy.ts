import { and, eq, isNull } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import { roles, tenants, users } from "../db/schema/index.ts";
import { principalHolds } from "../rbac/evaluator.ts";
import { now } from "../utils/clock.ts";

export type WorkflowApprovalPolicy = "single" | "pair";

export const PAIR_APPROVER_PERMISSION = "workflow:write";

export interface ApprovalPolicyState {
  readonly workflow_approvals: WorkflowApprovalPolicy;
  readonly changed_at: Date | null;
  readonly changed_by: string | null;
}

export class ApprovalPolicyError extends Error {
  constructor(
    readonly code: "pair_needs_two_approvers" | "tenant_not_found",
    readonly eligible: number,
  ) {
    super(code);
    this.name = "ApprovalPolicyError";
  }
}

export async function readApprovalPolicy(
  db: Executor,
  tenant_id: string,
): Promise<ApprovalPolicyState> {
  const [row] = await db
    .select({
      policy: tenants.workflow_approval_policy,
      changed_at: tenants.workflow_approval_policy_changed_at,
      changed_by: tenants.workflow_approval_policy_changed_by,
    })
    .from(tenants)
    .where(eq(tenants.id, tenant_id))
    .limit(1);
  return {
    workflow_approvals: row?.policy === "pair" ? "pair" : "single",
    changed_at: row?.changed_at ?? null,
    changed_by: row?.changed_by ?? null,
  };
}

export async function pairApprovalRequired(db: Executor, tenant_id: string): Promise<boolean> {
  return (await readApprovalPolicy(db, tenant_id)).workflow_approvals === "pair";
}

export function personPrincipal(
  tenant_id: string,
  user_id: string,
  role_name: string | null,
): ResolvedPrincipal {
  return {
    provider: "pair_approver",
    kind: "user",
    id: user_id,
    tenant_id,
    roles: role_name ? [role_name] : [],
  };
}

export async function activePersonPrincipal(
  db: Executor,
  tenant_id: string,
  user_id: string,
): Promise<ResolvedPrincipal | null> {
  const [person] = await db
    .select({ id: users.id, role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(
      and(
        eq(users.tenant_id, tenant_id),
        eq(users.id, user_id),
        eq(users.status, "active"),
        isNull(users.deleted_at),
      ),
    )
    .limit(1);
  return person ? personPrincipal(tenant_id, person.id, person.role_name) : null;
}

export async function eligiblePairApprovers(db: Executor, tenant_id: string): Promise<string[]> {
  const people = await db
    .select({ id: users.id, role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(
      and(eq(users.tenant_id, tenant_id), eq(users.status, "active"), isNull(users.deleted_at)),
    )
    .orderBy(users.id);
  const eligible: string[] = [];
  for (const person of people) {
    if (
      await principalHolds(
        db,
        personPrincipal(tenant_id, person.id, person.role_name),
        PAIR_APPROVER_PERMISSION,
      )
    )
      eligible.push(person.id);
  }
  return eligible;
}

export interface PolicyChange {
  readonly tenant_id: string;
  readonly next: WorkflowApprovalPolicy;
  readonly actor: { readonly type: "user" | "system"; readonly id: string | null };
  readonly source: "policy" | "setup" | "approver_joined";
}

export async function changeApprovalPolicy(
  db: Executor,
  change: PolicyChange,
): Promise<{ state: ApprovalPolicyState; eligible: number; changed: boolean }> {
  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .select({ id: tenants.id, policy: tenants.workflow_approval_policy })
      .from(tenants)
      .where(eq(tenants.id, change.tenant_id))
      .for("update")
      .limit(1);
    if (!tenant) throw new ApprovalPolicyError("tenant_not_found", 0);
    const eligible = (await eligiblePairApprovers(tx, change.tenant_id)).length;
    if (change.next === "pair" && eligible < 2)
      throw new ApprovalPolicyError("pair_needs_two_approvers", eligible);
    if (tenant.policy === change.next)
      return { state: await readApprovalPolicy(tx, change.tenant_id), eligible, changed: false };
    await tx
      .update(tenants)
      .set({
        workflow_approval_policy: change.next,
        workflow_approval_policy_changed_at: new Date(now()),
        workflow_approval_policy_changed_by: change.actor.id,
      })
      .where(eq(tenants.id, change.tenant_id));
    await auditAwait(
      {
        tenant_id: change.tenant_id,
        actor_type: change.actor.type,
        actor_id: change.actor.id,
        action: AuditAction.WORKSPACE_APPROVAL_POLICY_CHANGED,
        resource_type: "tenant",
        resource_id: change.tenant_id,
        result: "success",
        before: { workflow_approvals: tenant.policy },
        after: { workflow_approvals: change.next },
        metadata: { source: change.source, eligible_approvers: eligible },
      },
      tx,
    );
    return { state: await readApprovalPolicy(tx, change.tenant_id), eligible, changed: true };
  });
}
