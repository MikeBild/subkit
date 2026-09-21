import { z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import {
  browserSessionForPrincipal,
  SESSION_SLIDING_TTL_MS,
  verifyBrowserCsrf,
} from "../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  sessions,
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
import { invalidateOperationalOverview } from "../operator/index.ts";
import { can } from "../rbac/evaluator.ts";
import { activateReviewedDraft } from "./activate-reviewed-draft.ts";
import { workflowJsonDigest } from "./canonical-json.ts";
import type { ContentPublicationBoundaries } from "./content-publication-proposal.ts";
import { resolveWorkflowEffectManifest } from "./effect-resolution.ts";
import type { ReportDeliveryBoundaries } from "./report-delivery-proposal.ts";
import { normalizeWorkflowRunInput } from "./run-input.ts";
import { WorkflowDefSchema } from "./types.ts";
import { lockWorkflowForVersionWrite } from "./version-write-lock.ts";

export const GrantWorkflowAuthoritySchema = z
  .object({
    workflow_version_id: z.string().uuid(),
    expected_manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
    execution_environment: z.enum(["dev", "prod"]),
    valid_from: z.string().datetime({ offset: true }),
    valid_until: z.string().datetime({ offset: true }),
    max_runs: z.number().int().min(1).max(10_000),
    activation: z
      .object({ expected_current_version_id: z.string().uuid().nullable() })
      .strict()
      .optional(),
  })
  .strict();

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

// Admitted runs must use these options, not caller overrides. Automatic
// repair may prepare a new version but cannot replace the authorized version.
export function workflowAuthorityExecutionOptions(environment: "dev" | "prod") {
  return {
    execution_mode: environment,
    self_healing: { enabled: false },
    hold_writes: false,
  } as const;
}

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
    report_boundaries?: ReportDeliveryBoundaries;
    content_boundaries?: ContentPublicationBoundaries;
  } = {},
) {
  return resolveWorkflowEffectManifest(
    {
      ...input,
      execution_options_digest: workflowJsonDigest({
        ...workflowAuthorityExecutionOptions(input.execution_environment),
        default_workflow_timeout_ms: WORKFLOW_TIMEOUT_DEFAULT_MS,
        default_request_timeout_ms: REQUEST_TIMEOUT_DEFAULT_MS,
        default_request_max_retries: REQUEST_MAX_RETRIES_DEFAULT,
        step_output_fixtures: null,
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

async function requireHuman(context: HumanContext, workflow_id: string) {
  const { principal, request, db } = context;
  const session = await browserSessionForPrincipal(request, principal);
  if (!session) fail("human_session_required", "a signed human browser session is required");
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    !(await verifyBrowserCsrf(request.headers.get("x-subkit-csrf") ?? "", session))
  )
    fail("csrf_rejected", "a valid browser CSRF proof is required");
  const permission = await can(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission: "workflow:write",
    resource: { type: "workflow", id: workflow_id },
  });
  if (!permission.allow)
    fail("authority_permission_denied", "workflow:write permission is required");
  return session;
}

async function lockLiveSession(tx: Executor, session: Awaited<ReturnType<typeof requireHuman>>) {
  const [live] = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, session.session_id),
        eq(sessions.tenant_id, session.tenant_id),
        eq(sessions.user_id, session.user_id),
        isNull(sessions.revoked_at),
        sql`coalesce(${sessions.absolute_expires_at}, ${sessions.expires_at}) > clock_timestamp()`,
        sql`coalesce(${sessions.last_seen_at}, ${sessions.created_at}) > clock_timestamp() - (${SESSION_SLIDING_TTL_MS} * interval '1 millisecond')`,
      ),
    )
    .for("share")
    .limit(1);
  if (!live) fail("human_session_expired", "the human session has expired or was revoked");
}

async function resolveGrantedScheduleHold(
  authority: typeof workflowExecutionAuthorities.$inferSelect,
  activeVersion: string | null,
  tx: Executor,
) {
  if (activeVersion !== authority.workflow_version_id) return;
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
        sql`${authority.valid_until}::timestamptz > clock_timestamp()`,
        sql`${authority.reserved_runs} < ${authority.max_runs}`,
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
  const definition = WorkflowDefSchema.parse(version?.dag);
  for (const schedule of schedules) {
    if (
      definition.input_schema &&
      !validateAgainstJsonSchema(
        normalizeWorkflowRunInput(schedule.input) ?? null,
        definition.input_schema,
        "$input",
      ).valid
    )
      continue;
    // Approving is not running. While a schedule is held the scheduler keeps
    // its missed occurrence due (it restores the watermark after every refused
    // attempt), so lifting the hold alone makes that occurrence fire on the very
    // next tick — seconds after the click. The dialog the human just confirmed
    // says no run starts now and names the next scheduled time; in production a
    // destructive retention run and a report e-mail both went out within
    // seconds of an approval instead. Moving the watermark to the moment of
    // approval makes the statement true: the first run is the first cron
    // occurrence AFTER the approval, the same rule a newly created schedule
    // already follows. Occurrences missed while held are not replayed.
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
  })
  .strict();

/** Explicit human activation, without a grant or dispatch, also for one-shot-only effects. */
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
    await activateReviewedDraft(
      tx,
      workflow,
      input.workflow_version_id,
      input.expected_current_version_id,
      principal.id,
      true,
    );
  });
  invalidateOperationalOverview(principal.tenant_id);
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
) {
  const input = GrantWorkflowAuthoritySchema.parse(raw);
  const session = await requireHuman(context, workflow_id);
  const { db, principal } = context;
  const result = await db.transaction(async (tx) => {
    await lockLiveSession(tx, session);
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
    const until = new Date(input.valid_until);
    if (
      until <= from ||
      until <= new Date(now) ||
      until.getTime() - from.getTime() > 31 * 24 * 60 * 60_000
    )
      fail("authority_window_invalid", "choose a non-expired authority window of at most 31 days");
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
    // The workflow lock serializes identical browser retries. A lost response
    // must not grant another max_runs allowance or resurrect a revoked grant.
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
          eq(workflowExecutionAuthorities.valid_until, until),
          eq(workflowExecutionAuthorities.max_runs, input.max_runs),
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
      );
      workflow.current_version_id = input.workflow_version_id;
      workflow.lifecycle = "active";
    }
    if (existing) {
      await resolveGrantedScheduleHold(
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
        max_runs: input.max_runs,
        created_by: principal.id,
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
          valid_until: until.toISOString(),
          max_runs: input.max_runs,
        },
      },
      tx,
    );
    await resolveGrantedScheduleHold(
      authority,
      workflow.lifecycle === "active" ? workflow.current_version_id : null,
      tx,
    );
    return authority;
  });
  invalidateOperationalOverview(principal.tenant_id);
  return result;
}

export async function revokeWorkflowAuthority(
  workflow_id: string,
  authority_id: string,
  context: HumanContext,
) {
  const session = await requireHuman(context, workflow_id);
  const { db, principal } = context;
  return db.transaction(async (tx) => {
    await lockLiveSession(tx, session);
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
        metadata: { workflow_id },
      },
      tx,
    );
    return revoked;
  });
}
