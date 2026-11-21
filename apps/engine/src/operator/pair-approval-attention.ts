import { and, eq, gt, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import {
  userSetupPreferences,
  users,
  workflowAuthorityPairRequests,
  workflows,
} from "../db/schema/index.ts";
import { resourceAccess } from "../rbac/evaluator.ts";
import type { TenantFacts } from "./attention-readers.ts";
import { type AttentionItem, compareAttentionItems } from "./core/attention.ts";

export interface PendingPairRequest {
  readonly id: string;
  readonly workflow_id: string;
  readonly workflow_name: string | null;
  readonly execution_environment: "dev" | "prod";
  readonly first_approver_id: string;
  readonly created_at: Date;
  readonly expires_at: Date;
}

export const PAIR_WAITING_KIND = "pair_approval_waiting";

export function isOwnPairRequest(item: { readonly kind: string }): boolean {
  return item.kind === PAIR_WAITING_KIND;
}

export function pairApprovalHref(workflow_id: string, request_id: string): string {
  return `/cockpit/workflows/${encodeURIComponent(workflow_id)}?pair=${encodeURIComponent(request_id)}#workflow-automation`;
}

export function pairAttentionItem(
  request: PendingPairRequest,
  waiting_on: { user_id: string; name: string } | null,
  own = false,
): AttentionItem {
  return {
    id: `pair:${request.id}`,
    class: "decide",
    severity: own ? "notice" : "urgent",
    kind: own ? PAIR_WAITING_KIND : "pair_approval",
    subject: {
      kind: "workflow",
      id: request.workflow_id,
      name: request.workflow_name,
      environment: request.execution_environment,
    },
    reason: "pair_approval_requested",
    trigger: null,
    cause_class: null,
    counts: {},
    since: request.created_at.toISOString(),
    deadline: request.expires_at.toISOString(),
    detail: null,
    ...(waiting_on ? { waiting_on } : {}),
    actions: [
      {
        verb: "review",
        href: pairApprovalHref(request.workflow_id, request.id),
        primary: true,
        permission: "workflow:write",
      },
    ],
  };
}

export function pairAttentionFor(
  viewer_id: string,
  requests: readonly PendingPairRequest[],
  mayApprove: (workflow_id: string) => boolean,
  partner: { user_id: string; name: string } | null,
): AttentionItem[] {
  return requests.flatMap((request) => {
    if (request.first_approver_id === viewer_id)
      return [
        pairAttentionItem(request, partner && partner.user_id !== viewer_id ? partner : null, true),
      ];
    return mayApprove(request.workflow_id) ? [pairAttentionItem(request, null)] : [];
  });
}

async function pendingRequests(
  db: Db,
  tenant_id: string,
  now: Date,
): Promise<PendingPairRequest[]> {
  return db
    .select({
      id: workflowAuthorityPairRequests.id,
      workflow_id: workflowAuthorityPairRequests.workflow_id,
      workflow_name: workflows.name,
      execution_environment: workflowAuthorityPairRequests.execution_environment,
      first_approver_id: workflowAuthorityPairRequests.first_approver_id,
      created_at: workflowAuthorityPairRequests.created_at,
      expires_at: workflowAuthorityPairRequests.expires_at,
    })
    .from(workflowAuthorityPairRequests)
    .innerJoin(
      workflows,
      and(
        eq(workflows.tenant_id, workflowAuthorityPairRequests.tenant_id),
        eq(workflows.id, workflowAuthorityPairRequests.workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .where(
      and(
        eq(workflowAuthorityPairRequests.tenant_id, tenant_id),
        eq(workflowAuthorityPairRequests.state, "pending"),
        gt(workflowAuthorityPairRequests.expires_at, now),
      ),
    )
    .limit(100);
}

async function namedPartner(db: Db, tenant_id: string, user_id: string) {
  const [row] = await db
    .select({ id: users.id, name: users.display_name, email: users.email })
    .from(userSetupPreferences)
    .innerJoin(
      users,
      and(
        eq(users.tenant_id, userSetupPreferences.tenant_id),
        eq(users.id, userSetupPreferences.approver_user_id),
      ),
    )
    .where(
      and(
        eq(userSetupPreferences.tenant_id, tenant_id),
        eq(userSetupPreferences.user_id, user_id),
        eq(userSetupPreferences.approver_kind, "pair"),
        isNull(users.deleted_at),
      ),
    )
    .limit(1);
  return row ? { user_id: row.id, name: row.name?.trim() || row.email } : null;
}

export async function withPendingPairRequests(
  db: Db,
  tenant_id: string,
  facts: TenantFacts,
  now: Date,
): Promise<TenantFacts> {
  try {
    return { ...facts, pair_requests: await pendingRequests(db, tenant_id, now) };
  } catch {
    return facts;
  }
}

export async function withPairApprovals(
  db: Db,
  principal: ResolvedPrincipal,
  items: readonly AttentionItem[],
  pending: readonly PendingPairRequest[] | undefined,
  now: Date,
): Promise<AttentionItem[]> {
  if (principal.kind !== "user") return [...items];
  const requests = (pending ?? []).filter(
    (request) => request.expires_at.getTime() > now.getTime(),
  );
  if (requests.length === 0) return [...items];
  const access = await resourceAccess(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission: "workflow:write",
    resource_type: "workflow",
    quiet: true,
  });
  const partner = requests.some((request) => request.first_approver_id === principal.id)
    ? await namedPartner(db, principal.tenant_id, principal.id)
    : null;
  const added = pairAttentionFor(principal.id, requests, (id) => access.allows(id), partner);
  return [...items, ...added].sort(compareAttentionItems);
}
