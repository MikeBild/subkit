import { z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import {
  browserSessionForPrincipal,
  sessionSlidingMsSql,
  verifyBrowserCsrf,
} from "../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  sessions,
  taskGrants,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflowsSchedules,
  workflowVersions,
} from "../db/schema/index.ts";
import { validateAgainstJsonSchema } from "../execution/engine/envelope.ts";
import {
  REQUEST_MAX_RETRIES_DEFAULT,
  REQUEST_TIMEOUT_DEFAULT_MS,
} from "../execution/steps/request.ts";
import { WORKFLOW_TIMEOUT_DEFAULT_MS } from "../execution/timeouts.ts";
import { pairApprovalRequired } from "../identity/approval-policy.ts";
import { invalidateTenantState } from "../operator/index.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import { can } from "../rbac/evaluator.ts";
import { stripCalendarGates } from "../scheduler/calendar-gates.ts";
import { activateReviewedDraft } from "./activate-reviewed-draft.ts";
import { carryApprovalsForward } from "./authority-inheritance.ts";
import {
  type ContentPublicationBoundaries,
  contentBoundariesFromManifest,
} from "./content-publication-proposal.ts";
import {
  AUTHORITY_REPLACEMENT_MAX_HOPS,
  AUTHORITY_WINDOW_MAX_DAYS,
  isOpenEnded,
  replacementFor,
  windowValid,
  workflowAuthorityOptionsDigest,
} from "./core/authority.ts";
import {
  decideAuthorityExtension,
  reusableOpenEndedSuccessor,
} from "./core/authority-extension.ts";
import { assertDeviceApproval } from "./device-binding.ts";
import { resolveWorkflowEffectManifest } from "./effect-resolution.ts";
import type { WorkflowReadFacts } from "./read-facts.ts";
import {
  type ReportDeliveryBoundaries,
  reportBoundariesFromManifest,
} from "./report-delivery-proposal.ts";
import { normalizeWorkflowRunInput } from "./run-input.ts";
import { executableDefinition } from "./stored-definition.ts";
import { assertPreviewedToolPinsCurrent } from "./tool-pin-review.ts";
import { lockWorkflowForVersionWrite } from "./version-write-lock.ts";

export const GrantWorkflowAuthoritySchema = z
  .object({
    workflow_version_id: z.string().uuid(),
    expected_manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
    execution_environment: z.enum(["dev", "prod"]),
    valid_from: z.string().datetime({ offset: true }),
    valid_until: z.string().datetime({ offset: true }).nullable().optional(),
    max_runs: z.number().int().min(1).max(10_000).nullable().optional(),
    activation: z
      .object({ expected_current_version_id: z.string().uuid().nullable() })
      .strict()
      .optional(),
    conversation_id: z.string().uuid().optional(),
    start_run: z.boolean().optional(),
  })
  .strict();

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export { workflowAuthorityExecutionOptions } from "./core/authority.ts";

export function previewWorkflowAuthority(
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
  db: Executor,
  options: {
    include_review?: boolean;
    compare_tool_pins?: boolean;
    facts?: WorkflowReadFacts | undefined;
    report_boundaries?: ReportDeliveryBoundaries;
    content_boundaries?: ContentPublicationBoundaries;
  } = {},
) {
  return resolveWorkflowEffectManifest(
    {
      ...input,
      execution_options_digest: workflowAuthorityOptionsDigest(input.execution_environment, {
        workflow_timeout_ms: WORKFLOW_TIMEOUT_DEFAULT_MS,
        request_timeout_ms: REQUEST_TIMEOUT_DEFAULT_MS,
        request_max_retries: REQUEST_MAX_RETRIES_DEFAULT,
      }),
    },
    db,
    options,
  );
}

interface HumanContext {
  request: Request;
  principal: ResolvedPrincipal;
  db: Db;
}

export async function requireHumanBrowser(context: Pick<HumanContext, "request" | "principal">) {
  const { principal, request } = context;
  const session = await browserSessionForPrincipal(request, principal);
  if (!session) fail("human_session_required", "a signed human browser session is required");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    fail("csrf_rejected", "a request from another site is not accepted");
  return session;
}

export async function requireHumanSession(context: Pick<HumanContext, "request" | "principal">) {
  const session = await requireHumanBrowser(context);
  if (!(await verifyBrowserCsrf(context.request.headers.get("x-subkit-csrf") ?? "", session)))
    fail("csrf_rejected", "a valid browser CSRF proof is required");
  return session;
}

export async function mayGrantWorkflowAuthority(
  db: Executor,
  principal: ResolvedPrincipal,
  workflow_id: string,
): Promise<boolean> {
  const permission = await can(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission: "workflow:write",
    resource: { type: "workflow", id: workflow_id },
  });
  return permission.allow;
}

export async function requireHuman(context: HumanContext, workflow_id: string) {
  const session = await requireHumanSession(context);
  if (!(await mayGrantWorkflowAuthority(context.db, context.principal, workflow_id)))
    fail("authority_permission_denied", "workflow:write permission is required");
  return session;
}

const HUMAN_SESSION_PROOF: unique symbol = Symbol("human-session-proof");

export interface HumanSessionProof {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly installation_id: string | null;
  readonly [HUMAN_SESSION_PROOF]: true;
}

const provenTransactions = new WeakMap<HumanSessionProof, Executor>();

function assertHumanSessionProof(
  tx: Executor,
  proof: HumanSessionProof,
  principal: ResolvedPrincipal,
): void {
  if (
    provenTransactions.get(proof) !== tx ||
    proof.tenant_id !== principal.tenant_id ||
    proof.user_id !== principal.id
  )
    fail("human_session_required", "a signed human browser session is required");
}

export async function lockLiveSession(
  tx: Executor,
  session: Awaited<ReturnType<typeof requireHuman>>,
): Promise<HumanSessionProof> {
  const [live] = await tx
    .select({ id: sessions.id, installation_id: sessions.installation_id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, session.session_id),
        eq(sessions.tenant_id, session.tenant_id),
        eq(sessions.user_id, session.user_id),
        isNull(sessions.revoked_at),
        sql`coalesce(${sessions.absolute_expires_at}, ${sessions.expires_at}) > clock_timestamp()`,
        sql`coalesce(${sessions.last_seen_at}, ${sessions.created_at}) > clock_timestamp() - (${sessionSlidingMsSql()} * interval '1 millisecond')`,
      ),
    )
    .for("share")
    .limit(1);
  if (!live) fail("human_session_expired", "the human session has expired or was revoked");
  const proof: HumanSessionProof = Object.freeze({
    tenant_id: session.tenant_id,
    user_id: session.user_id,
    installation_id: live.installation_id ?? null,
    [HUMAN_SESSION_PROOF]: true as const,
  });
  provenTransactions.set(proof, tx);
  return proof;
}

async function resolveGrantedAdmissionHolds(
  authority: typeof workflowExecutionAuthorities.$inferSelect,
  activeVersion: string | null,
  tx: Executor,
) {
  if (activeVersion !== authority.workflow_version_id) return;
  if (authority.execution_environment === "prod") {
    await tx
      .select({ id: webhooksInbound.id })
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, authority.tenant_id),
          eq(webhooksInbound.workflow_id, authority.workflow_id),
        ),
      )
      .orderBy(webhooksInbound.id)
      .for("update");
    await tx
      .update(webhooksInbound)
      .set({ admission_hold: null })
      .where(
        and(
          eq(webhooksInbound.tenant_id, authority.tenant_id),
          eq(webhooksInbound.workflow_id, authority.workflow_id),
          sql`${webhooksInbound.admission_hold} IS NOT NULL`,
          sql`${authority.valid_from}::timestamptz <= clock_timestamp()`,
          sql`(${authority.valid_until}::timestamptz IS NULL OR ${authority.valid_until}::timestamptz > clock_timestamp())`,
          sql`(${authority.max_runs}::int IS NULL OR ${authority.reserved_runs}::int < ${authority.max_runs}::int)`,
          sql`${authority.revoked_at}::timestamptz IS NULL`,
        ),
      );
  }
  const schedules = await tx
    .select({ id: workflowsSchedules.id, input: workflowsSchedules.input })
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, authority.tenant_id),
        eq(workflowsSchedules.workflow_id, authority.workflow_id),
        eq(workflowsSchedules.execution_mode, authority.execution_environment),
        eq(workflowsSchedules.paused, false),
        sql`${workflowsSchedules.admission_hold} IS NOT NULL`,
        sql`${authority.valid_from}::timestamptz <= clock_timestamp()`,
        sql`(${authority.valid_until}::timestamptz IS NULL OR ${authority.valid_until}::timestamptz > clock_timestamp())`,
        sql`(${authority.max_runs}::int IS NULL OR ${authority.reserved_runs}::int < ${authority.max_runs}::int)`,
        sql`${authority.revoked_at}::timestamptz IS NULL`,
      ),
    )
    .for("update");
  if (!schedules.length) return;
  const [version] = await tx
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, authority.tenant_id),
        eq(workflowVersions.workflow_id, authority.workflow_id),
        eq(workflowVersions.id, authority.workflow_version_id),
      ),
    )
    .limit(1);
  const definition = executableDefinition(version?.dag);
  for (const schedule of schedules) {
    if (
      definition.input_schema &&
      !validateAgainstJsonSchema(
        normalizeWorkflowRunInput(stripCalendarGates(schedule.input)) ?? null,
        definition.input_schema,
        "$input",
      ).valid
    )
      continue;
    await tx
      .update(workflowsSchedules)
      .set({ admission_hold: null, last_enqueued_at: sql`clock_timestamp()` })
      .where(
        and(
          eq(workflowsSchedules.tenant_id, authority.tenant_id),
          eq(workflowsSchedules.id, schedule.id),
        ),
      );
    await auditAwait(
      {
        tenant_id: authority.tenant_id,
        actor_type: "user",
        actor_id: authority.created_by,
        action: AuditAction.SCHEDULE_ADMISSION_CHANGED,
        resource_type: "workflow_schedule",
        resource_id: schedule.id,
        result: "success",
        metadata: {
          request_source: "ui",
          state: "authorized",
          reason_code: null,
          workflow_id: authority.workflow_id,
          workflow_version_id: authority.workflow_version_id,
          execution_authority_id: authority.id,
        },
      },
      tx,
    );
  }
}

export const ActivateWorkflowDraftSchema = z
  .object({
    workflow_version_id: z.string().uuid(),
    expected_current_version_id: z.string().uuid().nullable(),
    expected_manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
    execution_environment: z.enum(["dev", "prod"]),
    conversation_id: z.string().uuid().optional(),
    start_run: z.boolean().optional(),
  })
  .strict();

export async function activateWorkflowDraftLocked(
  tx: Executor,
  workflow_id: string,
  input: z.infer<typeof ActivateWorkflowDraftSchema>,
  principal: ResolvedPrincipal,
): Promise<void> {
  const workflow = await lockWorkflowForVersionWrite(tx, principal.tenant_id, workflow_id);
  if (!workflow) fail("workflow_version_unavailable", "workflow version unavailable");
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: principal.tenant_id,
      workflow_id,
      workflow_version_id: input.workflow_version_id,
      execution_environment: input.execution_environment,
    },
    tx,
  );
  if (preview.digest !== input.expected_manifest_digest)
    fail("authority_manifest_changed", "the reviewed boundary changed; review again");
  const previous = workflow.current_version_id;
  await activateReviewedDraft(
    tx,
    workflow,
    input.workflow_version_id,
    input.expected_current_version_id,
    principal.id,
    true,
    { manifestDigestMatches: preview.digest === input.expected_manifest_digest },
    principal.kind,
  );
  await carryApprovalsForward(tx, {
    tenant_id: principal.tenant_id,
    workflow_id,
    from_version_id: previous,
    to_version_id: input.workflow_version_id,
    actor_id: principal.id,
    actor_type: principal.kind,
  });
}

export async function activateWorkflowDraft(
  workflow_id: string,
  raw: unknown,
  context: HumanContext,
) {
  const input = ActivateWorkflowDraftSchema.parse(raw);
  const session = await requireHuman(context, workflow_id);
  const { db, principal } = context;
  await db.transaction(async (tx) => {
    await lockLiveSession(tx, session);
    await activateWorkflowDraftLocked(tx, workflow_id, input, principal);
  });
  invalidateTenantState(principal.tenant_id);
  return {
    workflow_version_id: input.workflow_version_id,
    activated: true as const,
    execution_authorized: false as const,
  };
}

export async function grantWorkflowAuthority(
  workflow_id: string,
  raw: unknown,
  context: HumanContext,
  options: { tool_pins?: "compare" | "compared" | "refuse" } = {},
) {
  const input = GrantWorkflowAuthoritySchema.parse(raw);
  const session = await requireHuman(context, workflow_id);
  const { db, principal } = context;
  if ((options.tool_pins ?? "compare") === "compare")
    await assertPreviewedToolPinsCurrent(
      db,
      principal.tenant_id,
      input.expected_manifest_digest,
      () =>
        previewWorkflowAuthority(
          {
            tenant_id: principal.tenant_id,
            workflow_id,
            workflow_version_id: input.workflow_version_id,
            execution_environment: input.execution_environment,
          },
          db,
        ),
    );
  const result = await db.transaction(async (tx) => {
    const proof = await lockLiveSession(tx, session);
    return grantWorkflowAuthorityLocked(tx, proof, workflow_id, input, principal, {
      tool_pins: options.tool_pins === "refuse" ? "refuse" : "compared",
    });
  });
  invalidateTenantState(principal.tenant_id);
  return result;
}

export const PAIR_APPROVAL_REQUIRED_MESSAGE =
  "this workspace needs two people to approve a workflow; start a pair approval with POST /v1/workflows/{id}/pair-approvals";

async function refuseSinglePersonApproval(tx: Executor, tenant_id: string) {
  if (await pairApprovalRequired(tx, tenant_id))
    fail("pair_approval_required", PAIR_APPROVAL_REQUIRED_MESSAGE);
}

export async function grantWorkflowAuthorityLocked(
  tx: Executor,
  proof: HumanSessionProof,
  workflow_id: string,
  input: z.infer<typeof GrantWorkflowAuthoritySchema>,
  principal: ResolvedPrincipal,
  origin: {
    task_grant_id?: string;
    tool_pins?: "compared" | "refuse";
    pair_request_id?: string;
  } = {},
) {
  assertHumanSessionProof(tx, proof, principal);
  if (!origin.pair_request_id) await refuseSinglePersonApproval(tx, principal.tenant_id);
  const workflow = await lockWorkflowForVersionWrite(tx, principal.tenant_id, workflow_id);
  if (!workflow) fail("workflow_version_unavailable", "workflow version unavailable");
  const [version] = await tx
    .select({ id: workflowVersions.id })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, principal.tenant_id),
        eq(workflowVersions.workflow_id, workflow_id),
        eq(workflowVersions.id, input.workflow_version_id),
      ),
    )
    .for("update")
    .limit(1);
  if (!version) fail("workflow_version_unavailable", "workflow version unavailable");
  const clock = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  const now = clock.rows[0]?.now;
  if (!now) throw new Error("database clock unavailable");
  const from = new Date(input.valid_from);
  const until = input.valid_until ? new Date(input.valid_until) : null;
  const maxRuns = input.max_runs ?? null;
  if (!windowValid(from, until, new Date(now)))
    fail(
      "authority_window_invalid",
      `choose a non-expired authority window of at most ${AUTHORITY_WINDOW_MAX_DAYS} days`,
    );
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: principal.tenant_id,
      workflow_id,
      workflow_version_id: input.workflow_version_id,
      execution_environment: input.execution_environment,
    },
    tx,
  );
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
  await assertDeviceApproval(tx, proof, preview.manifest);
  if (origin.tool_pins !== "compared" && preview.manifest.effects.some((effect) => effect.mcp))
    fail(
      "mcp_tool_unavailable",
      "a tool this workflow calls could not be compared with its server; approve it from the workflow's own review",
    );
  const [existing] = await tx
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, principal.tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, workflow_id),
        eq(workflowExecutionAuthorities.workflow_version_id, version.id),
        eq(workflowExecutionAuthorities.effect_manifest_digest, preview.digest),
        eq(workflowExecutionAuthorities.execution_environment, input.execution_environment),
        eq(workflowExecutionAuthorities.valid_from, from),
        until
          ? eq(workflowExecutionAuthorities.valid_until, until)
          : isNull(workflowExecutionAuthorities.valid_until),
        maxRuns === null
          ? isNull(workflowExecutionAuthorities.max_runs)
          : eq(workflowExecutionAuthorities.max_runs, maxRuns),
        isNull(workflowExecutionAuthorities.inherited_from),
        eq(workflowExecutionAuthorities.created_by, principal.id),
      ),
    )
    .limit(1);
  if (existing?.revoked_at)
    fail("authority_revoked", "this exact grant was revoked; review a new boundary");
  if (input.activation) {
    await activateReviewedDraft(
      tx,
      workflow,
      input.workflow_version_id,
      input.activation.expected_current_version_id,
      principal.id,
      Boolean(existing),
      { manifestDigestMatches: preview.digest === input.expected_manifest_digest },
      principal.kind,
    );
    workflow.current_version_id = input.workflow_version_id;
    workflow.lifecycle = "active";
  }
  if (existing) {
    await resolveGrantedAdmissionHolds(
      existing,
      workflow.lifecycle === "active" ? workflow.current_version_id : null,
      tx,
    );
    return existing;
  }
  const targets = [
    ...new Set(
      preview.manifest.effects.flatMap((effect) => (effect.target ? [effect.target] : [])),
    ),
  ].sort();
  const [authority] = await tx
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: principal.tenant_id,
      workflow_id,
      workflow_version_id: version.id,
      effect_manifest_digest: preview.digest,
      effect_manifest: { ...preview.manifest },
      execution_environment: input.execution_environment,
      target_constraints: { targets },
      valid_from: from,
      valid_until: until,
      max_runs: maxRuns,
      created_by: principal.id,
      approved_manifest: { ...preview.manifest },
    })
    .returning();
  if (!authority) throw new Error("authority insert returned no row");
  await auditAwait(
    {
      tenant_id: principal.tenant_id,
      actor_type: "user",
      actor_id: principal.id,
      action: AuditAction.WORKFLOW_AUTHORITY_GRANTED,
      resource_type: "workflow_execution_authority",
      resource_id: authority.id,
      result: "success",
      metadata: {
        workflow_id,
        workflow_version_id: version.id,
        effect_manifest_digest: preview.digest,
        execution_environment: input.execution_environment,
        valid_from: from.toISOString(),
        valid_until: until?.toISOString() ?? null,
        max_runs: maxRuns,
        open_ended: until === null && maxRuns === null,
        ...(origin.task_grant_id ? { task_grant_id: origin.task_grant_id } : {}),
      },
    },
    tx,
  );
  await resolveGrantedAdmissionHolds(
    authority,
    workflow.lifecycle === "active" ? workflow.current_version_id : null,
    tx,
  );
  await emitResourceChange(tx, {
    tenant_id: principal.tenant_id,
    type: "workflow.authority_granted",
    ids: { workflow_id, workflow_version_id: version.id, authority_id: authority.id },
  });
  return authority;
}

export async function revokeWorkflowAuthority(
  workflow_id: string,
  authority_id: string,
  context: HumanContext,
) {
  const session = await requireHuman(context, workflow_id);
  const { db, principal } = context;
  return db.transaction(async (tx) => {
    const proof = await lockLiveSession(tx, session);
    return revokeWorkflowAuthorityLocked(tx, proof, workflow_id, authority_id, principal);
  });
}

export async function revokeWorkflowAuthorityLocked(
  tx: Executor,
  proof: HumanSessionProof,
  workflow_id: string,
  authority_id: string,
  principal: ResolvedPrincipal,
  origin: { task_grant_id?: string; reason_code?: string } = {},
) {
  assertHumanSessionProof(tx, proof, principal);
  const [authority] = await tx
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, principal.tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, workflow_id),
        eq(workflowExecutionAuthorities.id, authority_id),
      ),
    )
    .for("update")
    .limit(1);
  if (!authority) fail("authority_not_found", "execution authority unavailable");
  if (authority.revoked_at) return authority;
  const [revoked] = await tx
    .update(workflowExecutionAuthorities)
    .set({
      revoked_at: sql`clock_timestamp()`,
      revoked_by: principal.id,
    })
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, principal.tenant_id),
        eq(workflowExecutionAuthorities.id, authority_id),
      ),
    )
    .returning();
  if (!revoked) throw new Error("authority revocation returned no row");
  await auditAwait(
    {
      tenant_id: principal.tenant_id,
      actor_type: "user",
      actor_id: principal.id,
      action: AuditAction.WORKFLOW_AUTHORITY_REVOKED,
      resource_type: "workflow_execution_authority",
      resource_id: authority_id,
      result: "success",
      metadata: {
        workflow_id,
        ...(origin.task_grant_id ? { task_grant_id: origin.task_grant_id } : {}),
        ...(origin.reason_code ? { reason_code: origin.reason_code } : {}),
      },
    },
    tx,
  );
  await emitResourceChange(tx, {
    tenant_id: principal.tenant_id,
    type: "workflow.authority_revoked",
    ids: { workflow_id, authority_id },
  });
  return revoked;
}

export const TASK_GRANT_AUTHORITY_REVOCATION_REASONS = [
  "task_changed",
  "task_archived",
  "task_deleted",
  "grant_exhausted",
  "owner_unavailable",
] as const;

export type TaskGrantAuthorityRevocationReason =
  (typeof TASK_GRANT_AUTHORITY_REVOCATION_REASONS)[number];

export interface TaskGrantAuthorityEnd {
  live: typeof workflowExecutionAuthorities.$inferSelect | null;
  retained_successor_authority_id: string | null;
}

export async function taskGrantAuthorityEnd(
  tx: Executor,
  tenant_id: string,
  origin_authority_id: string,
): Promise<TaskGrantAuthorityEnd> {
  const lockRow = async (id: string) => {
    const [row] = await tx
      .select()
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, tenant_id),
          eq(workflowExecutionAuthorities.id, id),
        ),
      )
      .for("update")
      .limit(1);
    return row ?? null;
  };
  let current = await lockRow(origin_authority_id);
  for (let hop = 0; current?.superseded_by; hop++) {
    if (hop >= AUTHORITY_REPLACEMENT_MAX_HOPS)
      fail(
        "authority_chain_too_long",
        "the approval was carried forward too often to revoke safely; nothing was changed",
      );
    const next = await lockRow(current.superseded_by);
    if (!next) break;
    if (next.inherited_from !== current.id)
      return { live: null, retained_successor_authority_id: next.id };
    current = next;
  }
  return {
    live: current && !current.revoked_at && !current.superseded_by ? current : null,
    retained_successor_authority_id: null,
  };
}

export async function revokeAuthorityMintedByTaskGrant(
  tx: Executor,
  input: {
    tenant_id: string;
    task_grant_id: string;
    origin_authority_id: string;
    reason_code: TaskGrantAuthorityRevocationReason;
    actor: { type: "system" } | { type: "user"; id: string };
  },
): Promise<{
  revoked_authority_id: string | null;
  retained_successor_authority_id: string | null;
}> {
  if (!TASK_GRANT_AUTHORITY_REVOCATION_REASONS.includes(input.reason_code))
    fail("authority_revocation_reason_required", "a known revocation reason is required");
  const [grant] = await tx
    .select({ created_by: taskGrants.created_by })
    .from(taskGrants)
    .where(
      and(
        eq(taskGrants.tenant_id, input.tenant_id),
        eq(taskGrants.id, input.task_grant_id),
        sql`${taskGrants.workflow_authority_ids} @> ${JSON.stringify([input.origin_authority_id])}::jsonb`,
      ),
    )
    .limit(1);
  if (!grant) fail("authority_not_found", "execution authority unavailable");
  const end = await taskGrantAuthorityEnd(tx, input.tenant_id, input.origin_authority_id);
  const { live } = end;
  if (!live)
    return {
      revoked_authority_id: null,
      retained_successor_authority_id: end.retained_successor_authority_id,
    };
  const [revoked] = await tx
    .update(workflowExecutionAuthorities)
    .set({
      revoked_at: sql`clock_timestamp()`,
      revoked_by: input.actor.type === "user" ? input.actor.id : grant.created_by,
    })
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, input.tenant_id),
        eq(workflowExecutionAuthorities.id, live.id),
        isNull(workflowExecutionAuthorities.revoked_at),
      ),
    )
    .returning({ id: workflowExecutionAuthorities.id });
  if (!revoked) throw new Error("authority revocation returned no row");
  await auditAwait(
    {
      tenant_id: input.tenant_id,
      actor_type: input.actor.type,
      actor_id: input.actor.type === "user" ? input.actor.id : null,
      action: AuditAction.WORKFLOW_AUTHORITY_REVOKED,
      resource_type: "workflow_execution_authority",
      resource_id: live.id,
      result: "success",
      metadata: {
        workflow_id: live.workflow_id,
        task_grant_id: input.task_grant_id,
        reason_code: input.reason_code,
      },
    },
    tx,
  );
  await emitResourceChange(tx, {
    tenant_id: input.tenant_id,
    type: "workflow.authority_revoked",
    ids: { workflow_id: live.workflow_id, authority_id: live.id },
  });
  return { revoked_authority_id: live.id, retained_successor_authority_id: null };
}

export const MakeWorkflowAuthorityUntilRevokedSchema = z
  .object({ expected_manifest_digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

async function authorityRow(db: Executor, tenant_id: string, id: string) {
  const [row] = await db
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        eq(workflowExecutionAuthorities.id, id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function sameBoundaryReplacement(
  db: Executor,
  tenant_id: string,
  authority_id: string,
): Promise<string> {
  const origin = await authorityRow(db, tenant_id, authority_id);
  if (!origin) return authority_id;
  const chain = await db
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, origin.workflow_id),
        eq(workflowExecutionAuthorities.workflow_version_id, origin.workflow_version_id),
        eq(workflowExecutionAuthorities.execution_environment, origin.execution_environment),
      ),
    );
  return replacementFor([origin, ...chain.filter((row) => row.id !== origin.id)], authority_id);
}

export async function makeWorkflowAuthorityUntilRevoked(
  workflow_id: string,
  authority_id: string,
  raw: unknown,
  context: HumanContext,
) {
  const input = MakeWorkflowAuthorityUntilRevokedSchema.parse(raw);
  const session = await requireHuman(context, workflow_id);
  const { db, principal } = context;
  const result = await db.transaction(async (tx) => {
    const proof = await lockLiveSession(tx, session);
    await refuseSinglePersonApproval(tx, principal.tenant_id);
    const workflow = await lockWorkflowForVersionWrite(tx, principal.tenant_id, workflow_id);
    if (!workflow) fail("workflow_version_unavailable", "workflow version unavailable");
    const [previous] = await tx
      .select()
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, principal.tenant_id),
          eq(workflowExecutionAuthorities.workflow_id, workflow_id),
          eq(workflowExecutionAuthorities.id, authority_id),
        ),
      )
      .for("update")
      .limit(1);
    if (!previous) fail("authority_not_found", "execution authority unavailable");
    const review = decideAuthorityExtension({
      stage: "review",
      previous_digest: previous.effect_manifest_digest,
      expected_digest: input.expected_manifest_digest,
    });
    if (review.kind === "rejected") fail(review.code, review.message);
    if (previous.superseded_by) {
      const successor = await authorityRow(tx, principal.tenant_id, previous.superseded_by);
      if (successor && reusableOpenEndedSuccessor(successor, previous))
        return { authority: successor, changed: false };
    }
    const prior = decideAuthorityExtension({
      stage: "previous",
      revoked: Boolean(previous.revoked_at),
      open_ended: isOpenEnded(previous),
    });
    if (prior.kind === "rejected") fail(prior.code, prior.message);
    if (prior.kind === "unchanged") return { authority: previous, changed: false };
    const clock = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    const now = clock.rows[0]?.now;
    if (!now) throw new Error("database clock unavailable");
    const live = decideAuthorityExtension({
      stage: "live",
      valid_from_ms: previous.valid_from.getTime(),
      valid_until_ms: previous.valid_until?.getTime() ?? null,
      now_ms: new Date(now).getTime(),
      max_runs: previous.max_runs,
      reserved_runs: previous.reserved_runs,
    });
    if (live.kind === "rejected") fail(live.code, live.message);
    const current = await previewWorkflowAuthority(
      {
        tenant_id: principal.tenant_id,
        workflow_id,
        workflow_version_id: previous.workflow_version_id,
        execution_environment: previous.execution_environment,
      },
      tx,
      {
        report_boundaries: reportBoundariesFromManifest(previous.effect_manifest),
        content_boundaries: contentBoundariesFromManifest(previous.effect_manifest),
      },
    );
    const preview = decideAuthorityExtension({
      stage: "preview",
      current_digest: current.digest,
      previous_digest: previous.effect_manifest_digest,
      eligible_for_repeated_runs: current.eligible_for_repeated_runs,
    });
    if (preview.kind === "rejected") fail(preview.code, preview.message);
    await assertDeviceApproval(tx, proof, current.manifest);
    const [successor] = await tx
      .insert(workflowExecutionAuthorities)
      .values({
        tenant_id: principal.tenant_id,
        workflow_id,
        workflow_version_id: previous.workflow_version_id,
        effect_manifest_digest: previous.effect_manifest_digest,
        effect_manifest: previous.effect_manifest,
        execution_environment: previous.execution_environment,
        target_constraints: previous.target_constraints,
        valid_from: previous.valid_from,
        valid_until: null,
        max_runs: null,
        reserved_runs: previous.reserved_runs,
        created_by: principal.id,
        approved_manifest: previous.approved_manifest ?? previous.effect_manifest,
      })
      .returning();
    if (!successor) throw new Error("authority insert returned no row");
    const [ended] = await tx
      .update(workflowExecutionAuthorities)
      .set({
        revoked_at: sql`clock_timestamp()`,
        revoked_by: principal.id,
        superseded_by: successor.id,
      })
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, principal.tenant_id),
          eq(workflowExecutionAuthorities.id, previous.id),
        ),
      )
      .returning({ id: workflowExecutionAuthorities.id });
    if (!ended) throw new Error("authority replacement returned no row");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.WORKFLOW_AUTHORITY_EXPIRY_REMOVED,
        resource_type: "workflow_execution_authority",
        resource_id: successor.id,
        result: "success",
        metadata: {
          request_source: "ui",
          workflow_id,
          workflow_version_id: successor.workflow_version_id,
          execution_environment: successor.execution_environment,
          effect_manifest_digest: successor.effect_manifest_digest,
          replaced_authority_id: previous.id,
          previous_valid_until: previous.valid_until?.toISOString() ?? null,
          previous_max_runs: previous.max_runs,
          valid_from: successor.valid_from.toISOString(),
          valid_until: null,
          max_runs: successor.max_runs,
          reserved_runs: successor.reserved_runs,
        },
      },
      tx,
    );
    await resolveGrantedAdmissionHolds(
      successor,
      workflow.lifecycle === "active" ? workflow.current_version_id : null,
      tx,
    );
    await emitResourceChange(tx, {
      tenant_id: principal.tenant_id,
      type: "workflow.authority_granted",
      ids: {
        workflow_id,
        workflow_version_id: successor.workflow_version_id,
        authority_id: successor.id,
      },
    });
    return { authority: successor, changed: true };
  });
  if (result.changed) invalidateTenantState(principal.tenant_id);
  return result.authority;
}
