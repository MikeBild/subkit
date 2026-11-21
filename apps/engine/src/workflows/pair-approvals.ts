import type { z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  type PairApprovalStaleReason,
  users,
  type WorkflowAuthorityPairRequestRow,
  workflowAuthorityPairRequests,
} from "../db/schema/index.ts";
import { activePersonPrincipal, pairApprovalRequired } from "../identity/approval-policy.ts";
import { invalidateTenantState } from "../operator/index.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import { AUTHORITY_WINDOW_MAX_DAYS, windowValid } from "./core/authority.ts";
import {
  decidePair,
  effectivePairState,
  type PairDecision,
  type PairState,
  pairExpiry,
  viewerCanApprove,
} from "./core/pair-approval.ts";
import {
  GrantWorkflowAuthoritySchema,
  grantWorkflowAuthorityLocked,
  lockLiveSession,
  mayGrantWorkflowAuthority,
  previewWorkflowAuthority,
  requireHuman,
} from "./execution-authorities.ts";
import { assertPreviewedToolPinsCurrent } from "./tool-pin-review.ts";

interface HumanContext {
  request: Request;
  principal: ResolvedPrincipal;
  db: Db;
}

type GrantInput = z.infer<typeof GrantWorkflowAuthoritySchema>;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

async function databaseNow(tx: Executor): Promise<Date> {
  const clock = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  const value = clock.rows[0]?.now;
  if (!value) throw new Error("database clock unavailable");
  return new Date(value);
}

async function previewDigest(
  tx: Executor,
  tenant_id: string,
  workflow_id: string,
  input: GrantInput,
) {
  return previewWorkflowAuthority(
    {
      tenant_id,
      workflow_id,
      workflow_version_id: input.workflow_version_id,
      execution_environment: input.execution_environment,
    },
    tx,
  );
}

async function comparePins(context: HumanContext, workflow_id: string, input: GrantInput) {
  await assertPreviewedToolPinsCurrent(
    context.db,
    context.principal.tenant_id,
    input.expected_manifest_digest,
    () => previewDigest(context.db, context.principal.tenant_id, workflow_id, input),
  );
}

export async function requestPairApprovalLocked(
  tx: Executor,
  workflow_id: string,
  input: GrantInput,
  principal: ResolvedPrincipal,
): Promise<WorkflowAuthorityPairRequestRow> {
  if (!(await pairApprovalRequired(tx, principal.tenant_id)))
    fail(
      "pair_not_required",
      "this workspace lets one person approve; grant the approval directly",
    );
  const at = await databaseNow(tx);
  const from = new Date(input.valid_from);
  const until = input.valid_until ? new Date(input.valid_until) : null;
  if (!windowValid(from, until, at))
    fail(
      "authority_window_invalid",
      `choose a non-expired authority window of at most ${AUTHORITY_WINDOW_MAX_DAYS} days`,
    );
  const preview = await previewDigest(tx, principal.tenant_id, workflow_id, input);
  if (preview.digest !== input.expected_manifest_digest)
    fail(
      "authority_manifest_changed",
      "the reviewed version, target or permissions changed; review again",
    );
  if (!preview.eligible_for_repeated_runs)
    fail(
      "authority_effect_unbound",
      "the workflow requires concrete-run review for an unbound or unavailable effect",
    );
  const { start_run: _ignored, ...grant } = input;
  const [inserted] = await tx
    .insert(workflowAuthorityPairRequests)
    .values({
      tenant_id: principal.tenant_id,
      workflow_id,
      workflow_version_id: input.workflow_version_id,
      execution_environment: input.execution_environment,
      expected_manifest_digest: input.expected_manifest_digest,
      grant,
      first_approver_id: principal.id,
      expires_at: pairExpiry(at, until),
    })
    .returning();
  if (!inserted) throw new Error("pair request insert returned no row");
  await auditAwait(
    {
      tenant_id: principal.tenant_id,
      actor_type: "user",
      actor_id: principal.id,
      action: AuditAction.WORKFLOW_PAIR_APPROVAL_REQUESTED,
      resource_type: "workflow",
      resource_id: workflow_id,
      result: "success",
      metadata: {
        pair_request_id: inserted.id,
        workflow_version_id: inserted.workflow_version_id,
        execution_environment: inserted.execution_environment,
        expected_manifest_digest: inserted.expected_manifest_digest,
        valid_until: input.valid_until ?? null,
        max_runs: input.max_runs ?? null,
        expires_at: inserted.expires_at.toISOString(),
      },
    },
    tx,
  );
  await announce(tx, inserted);
  return inserted;
}

export async function requestPairApproval(
  workflow_id: string,
  raw: unknown,
  context: HumanContext,
): Promise<WorkflowAuthorityPairRequestRow> {
  const input = GrantWorkflowAuthoritySchema.parse(raw);
  if (input.start_run === true)
    fail(
      "pair_start_run_unsupported",
      "a pair approval starts no run; start one after both approved",
    );
  const session = await requireHuman(context, workflow_id);
  const { principal } = context;
  await comparePins(context, workflow_id, input);
  const row = await context.db.transaction(async (tx) => {
    await lockLiveSession(tx, session);
    return requestPairApprovalLocked(tx, workflow_id, input, principal);
  });
  invalidateTenantState(principal.tenant_id);
  return row;
}

async function announce(tx: Executor, row: WorkflowAuthorityPairRequestRow) {
  await emitResourceChange(tx, {
    tenant_id: row.tenant_id,
    type: "workflow.automation_changed",
    ids: { workflow_id: row.workflow_id, workflow_version_id: row.workflow_version_id },
  });
}

async function lockRequest(
  tx: Executor,
  tenant_id: string,
  workflow_id: string,
  request_id: string,
): Promise<WorkflowAuthorityPairRequestRow> {
  const [row] = await tx
    .select()
    .from(workflowAuthorityPairRequests)
    .where(
      and(
        eq(workflowAuthorityPairRequests.tenant_id, tenant_id),
        eq(workflowAuthorityPairRequests.workflow_id, workflow_id),
        eq(workflowAuthorityPairRequests.id, request_id),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) fail("pair_request_not_found", "pair approval request not found");
  return row;
}

const CLOSING_ACTIONS = {
  declined: AuditAction.WORKFLOW_PAIR_APPROVAL_DECLINED,
  withdrawn: AuditAction.WORKFLOW_PAIR_APPROVAL_WITHDRAWN,
  expired: AuditAction.WORKFLOW_PAIR_APPROVAL_EXPIRED,
  stale: AuditAction.WORKFLOW_PAIR_APPROVAL_STALE,
} as const;

async function closeRequest(
  tx: Executor,
  row: WorkflowAuthorityPairRequestRow,
  state: keyof typeof CLOSING_ACTIONS,
  at: Date,
  actor: { type: "user" | "system"; id: string | null },
  stale_reason: PairApprovalStaleReason | null = null,
): Promise<WorkflowAuthorityPairRequestRow> {
  const [closed] = await tx
    .update(workflowAuthorityPairRequests)
    .set({ state, stale_reason, decided_at: at, updated_at: at })
    .where(eq(workflowAuthorityPairRequests.id, row.id))
    .returning();
  if (!closed) throw new Error("pair request update returned no row");
  await announce(tx, closed);
  await auditAwait(
    {
      tenant_id: row.tenant_id,
      actor_type: actor.type,
      actor_id: actor.id,
      action: CLOSING_ACTIONS[state],
      resource_type: "workflow",
      resource_id: row.workflow_id,
      result: "success",
      reason: stale_reason,
      metadata: {
        pair_request_id: row.id,
        first_approver_id: row.first_approver_id,
        workflow_version_id: row.workflow_version_id,
      },
    },
    tx,
  );
  return closed;
}

type Settled =
  | { readonly ok: true; readonly row: WorkflowAuthorityPairRequestRow }
  | { readonly ok: false; readonly code: string; readonly message: string };

const CLOSED_MESSAGES: Record<string, string> = {
  pair_request_expired: "the request waited too long; ask for a new pair approval",
  pair_request_closed: "the request was already decided",
  pair_same_person: "the second approval has to come from another person",
  pair_not_requester: "only the person who asked, or an administrator, withdraws the request",
};

async function settle(context: HumanContext, work: (tx: Executor) => Promise<Settled>) {
  const settled = await context.db.transaction(work);
  invalidateTenantState(context.principal.tenant_id);
  if (!settled.ok) fail(settled.code, settled.message);
  return settled.row;
}

async function checkDecision(
  tx: Executor,
  row: WorkflowAuthorityPairRequestRow,
  decision: PairDecision,
  viewer_id: string,
  at: Date,
): Promise<Settled | null> {
  const verdict = decidePair(row, decision, viewer_id, at);
  if (verdict.ok) return null;
  if (verdict.code === "pair_request_expired")
    await closeRequest(tx, row, "expired", at, { type: "system", id: null });
  return { ok: false, code: verdict.code, message: CLOSED_MESSAGES[verdict.code] ?? verdict.code };
}

export async function approvePairRequest(
  workflow_id: string,
  request_id: string,
  context: HumanContext,
): Promise<{ request: WorkflowAuthorityPairRequestRow; authority_id: string }> {
  const session = await requireHuman(context, workflow_id);
  const { principal } = context;
  const [pending] = await context.db
    .select()
    .from(workflowAuthorityPairRequests)
    .where(
      and(
        eq(workflowAuthorityPairRequests.tenant_id, principal.tenant_id),
        eq(workflowAuthorityPairRequests.workflow_id, workflow_id),
        eq(workflowAuthorityPairRequests.id, request_id),
      ),
    )
    .limit(1);
  if (!pending) fail("pair_request_not_found", "pair approval request not found");
  const grant = GrantWorkflowAuthoritySchema.parse(pending.grant);
  if (pending.first_approver_id !== principal.id) await comparePins(context, workflow_id, grant);
  const row = await settle(context, async (tx) => {
    const proof = await lockLiveSession(tx, session);
    const request = await lockRequest(tx, principal.tenant_id, workflow_id, request_id);
    const at = await databaseNow(tx);
    const refused = await checkDecision(tx, request, { kind: "approve" }, principal.id, at);
    if (refused) return refused;
    const first = await activePersonPrincipal(tx, principal.tenant_id, request.first_approver_id);
    if (!first || !(await mayGrantWorkflowAuthority(tx, first, workflow_id))) {
      await closeRequest(
        tx,
        request,
        "stale",
        at,
        { type: "system", id: null },
        "first_approver_unavailable",
      );
      return {
        ok: false,
        code: "pair_request_stale",
        message: "the person who asked can no longer approve; ask for a new pair approval",
      };
    }
    const preview = await previewDigest(tx, principal.tenant_id, workflow_id, grant);
    if (preview.digest !== request.expected_manifest_digest) {
      await closeRequest(
        tx,
        request,
        "stale",
        at,
        { type: "system", id: null },
        "manifest_changed",
      );
      return {
        ok: false,
        code: "authority_manifest_changed",
        message: "the reviewed version, target or permissions changed; review again",
      };
    }
    const authority = await grantWorkflowAuthorityLocked(tx, proof, workflow_id, grant, principal, {
      pair_request_id: request.id,
      tool_pins: "compared",
    });
    const [approved] = await tx
      .update(workflowAuthorityPairRequests)
      .set({
        state: "approved",
        second_approver_id: principal.id,
        authority_id: authority.id,
        decided_at: at,
        updated_at: at,
      })
      .where(eq(workflowAuthorityPairRequests.id, request.id))
      .returning();
    if (!approved) throw new Error("pair request update returned no row");
    await announce(tx, approved);
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.WORKFLOW_PAIR_APPROVAL_APPROVED,
        resource_type: "workflow",
        resource_id: workflow_id,
        result: "success",
        metadata: {
          pair_request_id: request.id,
          first_approver_id: request.first_approver_id,
          second_approver_id: principal.id,
          authority_id: authority.id,
          workflow_version_id: request.workflow_version_id,
          execution_environment: request.execution_environment,
        },
      },
      tx,
    );
    return { ok: true, row: approved };
  });
  if (!row.authority_id) throw new Error("approved pair request has no authority");
  return { request: row, authority_id: row.authority_id };
}

async function closeByPerson(
  workflow_id: string,
  request_id: string,
  context: HumanContext,
  decision: PairDecision,
  state: "declined" | "withdrawn",
) {
  const session = await requireHuman(context, workflow_id);
  const { principal } = context;
  return settle(context, async (tx) => {
    await lockLiveSession(tx, session);
    const request = await lockRequest(tx, principal.tenant_id, workflow_id, request_id);
    const at = await databaseNow(tx);
    const refused = await checkDecision(tx, request, decision, principal.id, at);
    if (refused) return refused;
    return {
      ok: true,
      row: await closeRequest(tx, request, state, at, { type: "user", id: principal.id }),
    };
  });
}

export function declinePairRequest(workflow_id: string, request_id: string, context: HumanContext) {
  return closeByPerson(workflow_id, request_id, context, { kind: "decline" }, "declined");
}

export function withdrawPairRequest(
  workflow_id: string,
  request_id: string,
  context: HumanContext,
  admin: boolean,
) {
  return closeByPerson(workflow_id, request_id, context, { kind: "withdraw", admin }, "withdrawn");
}

export interface PairPerson {
  readonly user_id: string;
  readonly name: string;
}

export interface PairApprovalView {
  readonly row: WorkflowAuthorityPairRequestRow;
  readonly state: PairState;
  readonly first_approver: PairPerson;
  readonly second_approver: PairPerson | null;
  readonly viewer_can_approve: boolean;
}

async function peopleById(db: Executor, tenant_id: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, PairPerson>();
  const rows = await db
    .select({ id: users.id, name: users.display_name, email: users.email })
    .from(users)
    .where(and(eq(users.tenant_id, tenant_id), inArray(users.id, ids)));
  return new Map(
    rows.map((row) => [row.id, { user_id: row.id, name: row.name?.trim() || row.email }]),
  );
}

export async function viewPairRequests(
  db: Executor,
  viewer: ResolvedPrincipal,
  rows: readonly WorkflowAuthorityPairRequestRow[],
  at: Date,
): Promise<PairApprovalView[]> {
  const ids = [
    ...new Set(
      rows.flatMap((row) => [
        row.first_approver_id,
        row.second_approver_id ?? row.first_approver_id,
      ]),
    ),
  ];
  const people = await peopleById(db, viewer.tenant_id, ids);
  const mayByWorkflow = new Map<string, boolean>();
  const views: PairApprovalView[] = [];
  for (const row of rows) {
    let may = mayByWorkflow.get(row.workflow_id);
    if (may === undefined) {
      may =
        viewer.kind === "user" && (await mayGrantWorkflowAuthority(db, viewer, row.workflow_id));
      mayByWorkflow.set(row.workflow_id, may);
    }
    const person = (id: string) => people.get(id) ?? { user_id: id, name: id };
    views.push({
      row,
      state: effectivePairState(row, at),
      first_approver: person(row.first_approver_id),
      second_approver: row.second_approver_id ? person(row.second_approver_id) : null,
      viewer_can_approve: viewerCanApprove(row, viewer.id, may, at),
    });
  }
  return views;
}

export async function listPairRequests(
  db: Executor,
  tenant_id: string,
  filter: { workflow_id?: string; states?: readonly PairState[]; limit?: number },
): Promise<WorkflowAuthorityPairRequestRow[]> {
  return db
    .select()
    .from(workflowAuthorityPairRequests)
    .where(
      and(
        eq(workflowAuthorityPairRequests.tenant_id, tenant_id),
        filter.workflow_id
          ? eq(workflowAuthorityPairRequests.workflow_id, filter.workflow_id)
          : undefined,
        filter.states?.length
          ? inArray(workflowAuthorityPairRequests.state, [...filter.states])
          : undefined,
      ),
    )
    .orderBy(desc(workflowAuthorityPairRequests.created_at), desc(workflowAuthorityPairRequests.id))
    .limit(filter.limit ?? 50);
}
