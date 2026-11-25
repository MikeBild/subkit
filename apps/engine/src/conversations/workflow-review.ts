import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { browserSessionForPrincipal, verifyBrowserCsrf } from "../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  conversationDrafts,
  conversationElicitations,
  conversations,
  conversationToolCalls,
  skills as skillsTable,
  workflowReviewReceipts,
  workflows,
} from "../db/schema/index.ts";
import { pairApprovalRequired } from "../identity/approval-policy.ts";
import { personalDefaultEnvironment } from "../identity/setup-preferences.ts";
import { invalidateTenantState } from "../operator/index.ts";
import { can } from "../rbac/evaluator.ts";
import { createScheduleLocked } from "../scheduler/repo.ts";
import { inboundHookDeliveryRate } from "../scheduler/workflow-automation-view.ts";
import { suggestAuthorityBounds } from "../workflows/authority-suggestions.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import { RECEIPT_PURGE_BATCH, receiptsToPurge } from "../workflows/core/review-receipt.ts";
import { readDatabaseNow } from "../workflows/database-clock.ts";
import {
  activateWorkflowDraftLocked,
  GrantWorkflowAuthoritySchema,
  grantWorkflowAuthority,
  lockLiveSession,
  previewWorkflowAuthority,
} from "../workflows/execution-authorities.ts";
import { requestPairApprovalLocked } from "../workflows/pair-approvals.ts";
import {
  resolveWorkflowReviewManifest,
  workflowReviewBoundaryDigest,
} from "../workflows/review-manifest.ts";
import {
  FinalizeWorkflowReviewSchema,
  PrepareWorkflowReviewSchema,
  type WorkflowReviewReceipt,
  WorkflowReviewReceiptSchema,
} from "../workflows/review-receipt.ts";
import { readReviewTriggerState } from "../workflows/review-triggers.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import { resolveElicitation } from "./elicitations.ts";
import { commitWorkflowAtomic, workflowDefFromDraft } from "./persistence/commit-workflow.ts";
import { transitionConversation } from "./persistence/conversation-status.ts";
import {
  assertConversationWriter,
  readTaskRunScope,
  TaskRunLockedError,
} from "./service/task-run-access.ts";
import type { ToolContext } from "./tools/index.ts";
import type { DraftDocument } from "./types.ts";
import { assertReviewedToolPinsCurrent } from "./workflow-review-tool-pins.ts";

const REVIEW_ERROR_STATUS: Record<string, number> = {
  authority_permission_denied: 403,
  csrf_rejected: 403,
  human_session_required: 401,
  workflow_review_forbidden: 403,
  workflow_review_not_found: 404,
  workflow_review_stale: 409,
  pair_approval_required: 409,
  authority_manifest_changed: 409,
  workflow_review_expired: 410,
  pair_schedule_unsupported: 422,
  authority_window_invalid: 422,
  authority_effect_unbound: 422,
  workflow_not_ready: 422,
  preview_failed: 422,
  no_prior_approval: 422,
  warnings_unacknowledged: 422,
  partial_success_not_acknowledged: 422,
  no_meaningful_change: 422,
  playground_no_persist: 422,
  sensitive_save_override_forbidden: 403,
};

export class WorkflowReviewError extends Error {
  readonly status: number;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowReviewError";
    this.status = REVIEW_ERROR_STATUS[code] ?? 409;
  }
}

function fail(code: string, message: string): never {
  throw new WorkflowReviewError(code, message);
}

function asReviewError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (!(error instanceof WorkflowReviewError) && typeof code === "string")
    fail(code, (error as Error).message);
  throw error;
}

function toolPinRefusal(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    !(error instanceof WorkflowReviewError) &&
    (code === "mcp_tool_changed" || code === "mcp_tool_unavailable")
  )
    fail(code, (error as Error).message);
  throw error;
}

function isPendingWorkflowSave(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const intent = (input as { commit_intent?: unknown }).commit_intent;
  return (
    !!intent &&
    typeof intent === "object" &&
    !Array.isArray(intent) &&
    (intent as { kind?: unknown }).kind === "save_workflow_draft"
  );
}

function receiptView(row: typeof workflowReviewReceipts.$inferSelect): WorkflowReviewReceipt {
  const s = row.snapshot as Record<string, unknown>;
  return WorkflowReviewReceiptSchema.parse({
    receipt_id: row.id,
    status: row.status,
    snapshot_digest: row.snapshot_digest,
    expires_at: row.expires_at.toISOString(),
    workflow_name: s.workflow_name,
    workflow_slug: s.workflow_slug,
    reviewed_version_number: s.reviewed_version_number,
    environment: s.environment,
    description: s.description,
    checks: s.checks,
    effects: s.effects,
    affected_triggers: s.affected_triggers,
    actions: s.actions,
    suggested_actions: s.suggested_actions,
    result:
      row.status === "completed" && row.workflow_id
        ? {
            workflow_id: row.workflow_id,
            authority_id: row.authority_id,
            schedule_id: row.schedule_id,
            saved: true,
            activated: row.authority_id !== null,
            granted: row.authority_id !== null,
            pair_request_id: typeof s.pair_request_id === "string" ? s.pair_request_id : null,
          }
        : null,
  });
}

async function refuseInTaskRun(
  db: Db,
  p: { tenant_id: string; conversation_id: string; principal: ResolvedPrincipal },
): Promise<void> {
  if (await readTaskRunScope(db, p.tenant_id, p.conversation_id))
    throw new TaskRunLockedError("Reviewing or activating a workflow");
  await assertConversationWriter(db, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.principal.id,
    principal: p.principal,
  });
}

export async function prepareWorkflowReview(
  p: {
    tenant_id: string;
    conversation_id: string;
    principal: ResolvedPrincipal;
    session_id: string;
    raw: unknown;
  },
  db: Db,
): Promise<WorkflowReviewReceipt> {
  await refuseInTaskRun(db, p);
  const input = PrepareWorkflowReviewSchema.parse(p.raw);
  if (input.activate !== Boolean(input.grant) || (input.schedule && !input.grant))
    fail(
      "workflow_review_actions_invalid",
      "a schedule requires activation and a bounded execution authority",
    );
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
      .for("update")
      .limit(1);
    if (!conversation) fail("conversation_not_found", "conversation unavailable");
    const [elicitation] = await tx
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, p.tenant_id),
          eq(conversationElicitations.conversation_id, p.conversation_id),
          eq(conversationElicitations.id, input.elicitation_id),
          eq(conversationElicitations.status, "pending"),
        ),
      )
      .for("update")
      .limit(1);
    if (elicitation?.tool_name !== "ask_user_confirm" || !isPendingWorkflowSave(elicitation.input))
      fail("review_elicitation_unavailable", "the pending save confirmation is unavailable");
    const [draft] = await tx
      .select()
      .from(conversationDrafts)
      .where(
        and(
          eq(conversationDrafts.tenant_id, p.tenant_id),
          eq(conversationDrafts.conversation_id, p.conversation_id),
        ),
      )
      .orderBy(desc(conversationDrafts.ordinal))
      .limit(1);
    const source = draft ? await loadDraft(p.tenant_id, p.conversation_id, tx, p.principal) : null;
    if (!source || typeof source !== "object")
      fail("workflow_draft_unavailable", "workflow draft unavailable");
    const workflow = (source as unknown as { workflow?: Record<string, unknown> }).workflow;
    if (!workflow?.name || !Array.isArray(workflow.steps))
      fail("workflow_draft_unavailable", "workflow draft unavailable");
    if (typeof workflow.derived_from_skill_id === "string") {
      const [derivedSkill] = await tx
        .select({ side_effects: skillsTable.side_effects })
        .from(skillsTable)
        .where(
          and(
            eq(skillsTable.tenant_id, p.tenant_id),
            eq(skillsTable.slug, workflow.derived_from_skill_id),
          ),
        )
        .limit(1);
      if (derivedSkill?.side_effects === "destructive")
        fail(
          "destructive_skill_confirmation_required",
          "the destructive derived skill requires its explicit confirmation path",
        );
    }
    const [saved] = conversation.target_workflow_id
      ? await tx
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.tenant_id, p.tenant_id),
              eq(workflows.id, conversation.target_workflow_id),
              isNull(workflows.deleted_at),
            ),
          )
          .limit(1)
      : [];
    const permission = await can(tx, {
      tenant_id: p.tenant_id,
      principal: p.principal,
      permission: "workflow:write",
      ...(saved ? { resource: { type: "workflow", id: saved.id } } : {}),
    });
    if (!permission.allow)
      fail("authority_permission_denied", "workflow:write permission is required");
    const saved_definition = workflowDefFromDraft(source.workflow);
    const manifest = await resolveWorkflowReviewManifest(
      {
        tenant_id: p.tenant_id,
        workflow_id: saved?.id ?? null,
        definition: saved_definition,
        environment: input.grant?.environment ?? "prod",
      },
      tx,
    );
    if (input.grant && !manifest.eligible_for_repeated_runs)
      fail(
        "workflow_review_authority_unavailable",
        "the reviewed workflow is not ready for repeated runs",
      );
    const effects = manifest.effects;
    const trigger = workflow.trigger as Record<string, unknown> | undefined;
    const trigger_state = await readReviewTriggerState(p.tenant_id, saved?.id ?? null, tx);
    const affected_triggers = trigger_state
      .filter((entry) => entry.active)
      .map(({ kind, name, cron, timezone }) => ({
        kind,
        name,
        ...(cron ? { cron } : {}),
        ...(timezone ? { timezone } : {}),
      }));
    const suggestedAt = new Date();
    const observedHooks = saved
      ? await inboundHookDeliveryRate(p.tenant_id, saved.id, tx, suggestedAt)
      : null;
    const suggestedBounds = suggestAuthorityBounds(
      suggestedAt,
      manifest.affected_triggers.flatMap((entry) =>
        entry.cron && entry.timezone ? [{ cron: entry.cron, timezone: entry.timezone }] : [],
      ),
      observedHooks ??
        (manifest.affected_triggers.some((entry) => entry.kind === "webhook")
          ? { deliveries: 0, window_days: 0 }
          : null),
    );
    const { valid_from, valid_until, max_runs } = suggestedBounds;
    const personal = input.grant
      ? null
      : await personalDefaultEnvironment(tx, p.tenant_id, p.principal);
    const devEligible =
      personal === "dev" &&
      (
        await resolveWorkflowReviewManifest(
          {
            tenant_id: p.tenant_id,
            workflow_id: saved?.id ?? null,
            definition: saved_definition,
            environment: "dev",
          },
          tx,
        )
      ).eligible_for_repeated_runs;
    const snapshot = {
      elicitation_id: elicitation.id,
      conversation_draft_id: draft?.id ?? null,
      conversation_draft_digest: workflowJsonDigest(source),
      workflow_name: String(workflow.name),
      workflow_slug: typeof workflow.slug === "string" ? workflow.slug : null,
      reviewed_version_number: null,
      environment: input.grant?.environment ?? null,
      description: typeof workflow.description === "string" ? workflow.description : "",
      checks: [
        ...workflow.steps.map((step) => {
          const value = step as { id?: unknown; kind?: unknown; method?: unknown };
          return [value.id, value.method ?? value.kind]
            .filter((part) => typeof part === "string")
            .join(" · ");
        }),
        source.latest_preview?.ok === true
          ? source.latest_preview.mode === "schema_only"
            ? "review:schema_checked"
            : "review:preview_passed"
          : "review:preview_unavailable",
      ],
      effects,
      affected_triggers,
      trigger_state,
      manifest_digest: manifest.digest,
      eligible_for_repeated_runs: manifest.eligible_for_repeated_runs,
      actions: { activate: input.activate, grant: input.grant, schedule: input.schedule },
      suggested_actions: {
        activate: false,
        grant: devEligible
          ? { environment: "dev" as const, valid_from, valid_until, max_runs }
          : manifest.eligible_for_repeated_runs
            ? { environment: "prod" as const, valid_from, valid_until, max_runs }
            : null,
        schedule:
          trigger?.kind === "schedule" && typeof trigger.cron === "string"
            ? {
                cron: trigger.cron,
                timezone: typeof trigger.timezone === "string" ? trigger.timezone : "UTC",
              }
            : null,
      },
      saved_definition,
      expected_current_version_id: saved?.current_version_id ?? null,
      expected_draft_version_id: saved?.draft_version_id ?? null,
    };
    const snapshot_digest = workflowJsonDigest(snapshot);
    await purgeSpentReviewReceipts(tx, p.tenant_id, await readDatabaseNow(tx));
    await tx
      .delete(workflowReviewReceipts)
      .where(
        and(
          eq(workflowReviewReceipts.tenant_id, p.tenant_id),
          eq(workflowReviewReceipts.conversation_id, p.conversation_id),
          eq(workflowReviewReceipts.prepared_by, p.principal.id),
          eq(workflowReviewReceipts.session_id, p.session_id),
          eq(workflowReviewReceipts.status, "pending"),
        ),
      );
    const [receipt] = await tx
      .insert(workflowReviewReceipts)
      .values({
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        workflow_id: saved?.id ?? null,
        prepared_by: p.principal.id,
        session_id: p.session_id,
        snapshot,
        snapshot_digest,
        expires_at: sql`clock_timestamp() + interval '10 minutes'`,
      })
      .returning();
    if (!receipt) throw new Error("review receipt insert failed");
    return receiptView(receipt);
  });
}

export async function purgeSpentReviewReceipts(
  tx: Executor,
  tenant_id: string,
  now: Date,
  keepId: string | null = null,
): Promise<number> {
  const candidates = await tx
    .select({
      id: workflowReviewReceipts.id,
      status: workflowReviewReceipts.status,
      expires_at: workflowReviewReceipts.expires_at,
    })
    .from(workflowReviewReceipts)
    .where(
      and(
        eq(workflowReviewReceipts.tenant_id, tenant_id),
        or(
          eq(workflowReviewReceipts.status, "completed"),
          lte(workflowReviewReceipts.expires_at, now),
        ),
      ),
    )
    .limit(RECEIPT_PURGE_BATCH + 1);
  const ids = receiptsToPurge(candidates, now, keepId);
  if (ids.length === 0) return 0;
  await tx
    .delete(workflowReviewReceipts)
    .where(
      and(eq(workflowReviewReceipts.tenant_id, tenant_id), inArray(workflowReviewReceipts.id, ids)),
    );
  return ids.length;
}

export async function getWorkflowReview(
  p: {
    tenant_id: string;
    conversation_id: string;
    receipt_id: string;
    principal: ResolvedPrincipal;
    session_id: string;
  },
  db: Executor,
): Promise<WorkflowReviewReceipt> {
  const [receipt] = await db
    .select()
    .from(workflowReviewReceipts)
    .where(
      and(
        eq(workflowReviewReceipts.tenant_id, p.tenant_id),
        eq(workflowReviewReceipts.conversation_id, p.conversation_id),
        eq(workflowReviewReceipts.id, p.receipt_id),
      ),
    )
    .limit(1);
  if (!receipt) fail("workflow_review_not_found", "review receipt unavailable");
  if (receipt.prepared_by !== p.principal.id || receipt.session_id !== p.session_id)
    fail("workflow_review_forbidden", "review receipt belongs to another signed-in session");
  const permission = await can(db, {
    tenant_id: p.tenant_id,
    principal: p.principal,
    permission: "workflow:write",
    ...(receipt.workflow_id ? { resource: { type: "workflow", id: receipt.workflow_id } } : {}),
  });
  if (!permission.allow)
    fail("authority_permission_denied", "workflow:write permission is required");
  return receiptView(receipt);
}

export async function finalizeWorkflowReview(
  p: {
    tenant_id: string;
    conversation_id: string;
    receipt_id: string;
    principal: ResolvedPrincipal;
    request: Request;
    raw: unknown;
  },
  db: Db,
): Promise<WorkflowReviewReceipt> {
  await refuseInTaskRun(db, p);
  const input = FinalizeWorkflowReviewSchema.parse(p.raw);
  const session = await browserSessionForPrincipal(p.request, p.principal);
  if (!session) fail("human_session_required", "a signed human browser session is required");
  if (
    p.request.headers.get("sec-fetch-site") === "cross-site" ||
    !(await verifyBrowserCsrf(p.request.headers.get("x-subkit-csrf") ?? "", session))
  )
    fail("csrf_rejected", "a valid browser CSRF proof is required");
  if (!input.save_only)
    await assertReviewedToolPinsCurrent(db, {
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      receipt_id: p.receipt_id,
      principal: p.principal,
      session_id: session.session_id,
    }).catch(toolPinRefusal);
  return db
    .transaction(async (tx) => {
      await lockLiveSession(tx, session);
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)),
        )
        .for("update")
        .limit(1);
      if (!conversation) fail("conversation_not_found", "conversation unavailable");
      const [receipt] = await tx
        .select()
        .from(workflowReviewReceipts)
        .where(
          and(
            eq(workflowReviewReceipts.tenant_id, p.tenant_id),
            eq(workflowReviewReceipts.conversation_id, p.conversation_id),
            eq(workflowReviewReceipts.id, p.receipt_id),
          ),
        )
        .for("update")
        .limit(1);
      if (!receipt) fail("workflow_review_not_found", "review receipt unavailable");
      if (receipt.prepared_by !== p.principal.id || receipt.session_id !== session.session_id)
        fail("workflow_review_forbidden", "review receipt belongs to another signed-in session");
      const permission = await can(tx, {
        tenant_id: p.tenant_id,
        principal: p.principal,
        permission: "workflow:write",
        ...(receipt.workflow_id ? { resource: { type: "workflow", id: receipt.workflow_id } } : {}),
      });
      if (!permission.allow)
        fail("authority_permission_denied", "workflow:write permission is required");
      if (receipt.snapshot_digest !== input.expected_snapshot_digest)
        fail("workflow_review_stale", "the review changed; prepare it again");
      if (receipt.status === "completed") return { view: receiptView(receipt), pair: false };
      const clock = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
      const clockValue = clock.rows[0]?.now;
      const now = clockValue ? new Date(clockValue) : null;
      if (!now || !Number.isFinite(now.getTime()) || receipt.expires_at <= now)
        fail("workflow_review_expired", "the review expired; prepare it again");

      const snapshot = receipt.snapshot as Record<string, unknown>;
      const elicitationId =
        typeof snapshot.elicitation_id === "string" ? snapshot.elicitation_id : null;
      if (!elicitationId)
        fail("workflow_review_stale", "the review is incomplete; prepare it again");
      const [elicitation] = await tx
        .select({
          id: conversationElicitations.id,
          tool_call_id: conversationElicitations.tool_call_id,
        })
        .from(conversationElicitations)
        .where(
          and(
            eq(conversationElicitations.tenant_id, p.tenant_id),
            eq(conversationElicitations.conversation_id, p.conversation_id),
            eq(conversationElicitations.id, elicitationId),
            eq(conversationElicitations.status, "pending"),
            sql`${conversationElicitations.input}->'commit_intent'->>'kind' = 'save_workflow_draft'`,
          ),
        )
        .for("update")
        .limit(1);
      if (!elicitation)
        fail("workflow_review_stale", "the confirmation changed; prepare the review again");
      const latest = await loadDraft(p.tenant_id, p.conversation_id, tx, p.principal);
      if (workflowJsonDigest(latest) !== snapshot.conversation_draft_digest)
        fail("workflow_review_stale", "the draft changed; prepare it again");
      const trigger_state = await readReviewTriggerState(
        p.tenant_id,
        receipt.workflow_id,
        tx,
        true,
      );
      if (workflowJsonDigest(trigger_state) !== workflowJsonDigest(snapshot.trigger_state ?? []))
        fail("workflow_review_stale", "affected triggers changed; prepare the review again");
      const fullDraft = latest as DraftDocument;
      let savedDraft = fullDraft;
      const ctx: ToolContext = {
        db: tx,
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        actor_id: p.principal.id,
        principal: p.principal,
        connector_id: null,
        workflow_id: receipt.workflow_id,
        engineClient: {} as ToolContext["engineClient"],
        getDraft: () => savedDraft,
        setDraft: async (next) => {
          savedDraft = next;
          await appendSnapshot(p.tenant_id, p.conversation_id, next, tx);
        },
        ask_before_writing: true,
      };
      const saved = await commitWorkflowAtomic({
        ctx,
        skipPriorApprovalCheck: true,
        expected_draft_version_id:
          typeof snapshot.expected_draft_version_id === "string"
            ? snapshot.expected_draft_version_id
            : null,
        reason: "workflow_review_finalized",
      });
      if (!saved.ok)
        fail(
          saved.error_code ?? "workflow_review_save_failed",
          saved.message ?? "workflow draft could not be saved",
        );
      const result = (saved.data ?? {}) as Record<string, unknown>;
      const workflow_id =
        typeof result.workflow_id === "string" ? result.workflow_id : saved.committed_workflow_id;
      const workflow_version_id =
        typeof result.workflow_version_id === "string" ? result.workflow_version_id : null;
      if (!workflow_id || !workflow_version_id)
        fail("workflow_review_save_failed", "save returned no workflow");

      const actions = snapshot.actions as {
        activate?: boolean;
        grant?: {
          environment: "dev" | "prod";
          valid_from: string;
          valid_until?: string | null;
          max_runs?: number | null;
        } | null;
        schedule?: { cron: string; timezone: string; input?: unknown; paused?: boolean } | null;
      };
      if (actions.activate !== Boolean(actions.grant) || (actions.schedule && !actions.grant))
        fail(
          "workflow_review_actions_invalid",
          "a schedule requires activation and a bounded execution authority",
        );
      const reviewedManifest = await resolveWorkflowReviewManifest(
        {
          tenant_id: p.tenant_id,
          workflow_id,
          definition: snapshot.saved_definition,
          environment: actions.grant?.environment ?? "prod",
        },
        tx,
      );
      if (reviewedManifest.digest !== snapshot.manifest_digest)
        fail("workflow_review_stale", "the reviewed effects changed; prepare the review again");
      let authority_id: string | null = null;
      const manifest = await previewWorkflowAuthority(
        {
          tenant_id: p.tenant_id,
          workflow_id,
          workflow_version_id,
          execution_environment: actions.grant?.environment ?? "prod",
        },
        tx,
      );
      if (workflowReviewBoundaryDigest(manifest.manifest) !== snapshot.manifest_digest)
        fail("workflow_review_stale", "the saved effects differ from the reviewed effects");
      let pair_request_id: string | null = null;
      const pair =
        !input.save_only && actions.grant ? await pairApprovalRequired(tx, p.tenant_id) : false;
      if (pair && actions.schedule)
        fail(
          "pair_schedule_unsupported",
          "a schedule waits until both people approved; add it after the second approval",
        );
      if (pair && actions.grant) {
        const requested = await requestPairApprovalLocked(
          tx,
          workflow_id,
          GrantWorkflowAuthoritySchema.parse({
            workflow_version_id,
            expected_manifest_digest: manifest.digest,
            execution_environment: actions.grant.environment,
            valid_from: actions.grant.valid_from,
            ...(actions.grant.valid_until !== undefined
              ? { valid_until: actions.grant.valid_until }
              : {}),
            ...(actions.grant.max_runs !== undefined ? { max_runs: actions.grant.max_runs } : {}),
            ...(actions.activate
              ? {
                  activation: {
                    expected_current_version_id: snapshot.expected_current_version_id ?? null,
                  },
                }
              : {}),
            conversation_id: p.conversation_id,
          }),
          p.principal,
        ).catch(asReviewError);
        pair_request_id = requested.id;
      } else if (!input.save_only && actions.grant) {
        const granted = await grantWorkflowAuthority(
          workflow_id,
          {
            workflow_version_id,
            expected_manifest_digest: manifest.digest,
            execution_environment: actions.grant.environment,
            valid_from: actions.grant.valid_from,
            ...(actions.grant.valid_until !== undefined
              ? { valid_until: actions.grant.valid_until }
              : {}),
            ...(actions.grant.max_runs !== undefined ? { max_runs: actions.grant.max_runs } : {}),
            ...(actions.activate
              ? {
                  activation: {
                    expected_current_version_id: snapshot.expected_current_version_id ?? null,
                  },
                }
              : {}),
            conversation_id: p.conversation_id,
          },
          { db: tx as unknown as Db, principal: p.principal, request: p.request },
          { tool_pins: "compared" },
        );
        authority_id = granted.id;
      } else if (!input.save_only && actions.activate) {
        await activateWorkflowDraftLocked(
          tx,
          workflow_id,
          {
            workflow_version_id,
            expected_current_version_id:
              typeof snapshot.expected_current_version_id === "string"
                ? snapshot.expected_current_version_id
                : null,
            expected_manifest_digest: manifest.digest,
            execution_environment: "prod",
            conversation_id: p.conversation_id,
          },
          p.principal,
        );
      }
      let schedule_id: string | null = null;
      if (!input.save_only && actions.schedule) {
        const schedule = await createScheduleLocked(tx, {
          tenant_id: p.tenant_id,
          workflow_id,
          cron: actions.schedule.cron,
          timezone: actions.schedule.timezone,
          ...(actions.schedule.input !== undefined ? { input: actions.schedule.input } : {}),
          ...(actions.schedule.paused !== undefined ? { paused: actions.schedule.paused } : {}),
          ...(actions.grant ? { execution_mode: actions.grant.environment } : {}),
          creator: p.principal,
        });
        schedule_id = schedule.row.id;
      }
      const [completed] = await tx
        .update(workflowReviewReceipts)
        .set({
          workflow_id,
          authority_id,
          schedule_id,
          ...(pair_request_id ? { snapshot: { ...snapshot, pair_request_id } } : {}),
          status: "completed",
          completed_at: now,
          updated_at: now,
        })
        .where(eq(workflowReviewReceipts.id, receipt.id))
        .returning();
      if (!completed) throw new Error("review receipt completion failed");
      await purgeSpentReviewReceipts(tx, p.tenant_id, now, completed.id);
      const resolved = await resolveElicitation(
        {
          tenant_id: p.tenant_id,
          id: elicitation.id,
          output: { confirmed: true, receipt_id: receipt.id, workflow_id },
          decided_by: { kind: "user", id: p.principal.id },
        },
        tx,
      );
      if (resolved.kind !== "resolved")
        fail("workflow_review_stale", "the confirmation changed; prepare the review again");
      if (elicitation.tool_call_id) {
        await tx
          .update(conversationToolCalls)
          .set({
            output: {
              ok: true,
              data: {
                workflow_id,
                workflow_version_id,
                review_receipt_id: receipt.id,
                ...(pair_request_id ? { pair_request_id } : {}),
              },
            },
            outcome: "ok",
          })
          .where(
            and(
              eq(conversationToolCalls.tenant_id, p.tenant_id),
              eq(conversationToolCalls.id, elicitation.tool_call_id),
            ),
          );
      }
      await transitionConversation(tx, {
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        to: "active",
        set: { updated_at: now },
      });
      return { view: receiptView(completed), pair: pair_request_id !== null };
    })
    .then(({ view, pair }) => {
      if (pair) invalidateTenantState(p.tenant_id);
      return view;
    })
    .catch(toolPinRefusal);
}
