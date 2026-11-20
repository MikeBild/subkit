import { z } from "@hono/zod-openapi";
import {
  ENVIRONMENT_BLOCK_CODES,
  ENVIRONMENT_RECOMMENDATION_REASONS,
} from "@shared/approval-choice.ts";
import { browserSessionForPrincipal } from "../../auth/browser-session.ts";
import type { Executor } from "../../db/client.ts";
import { can } from "../../rbac/evaluator.ts";
import { nextScheduleFire } from "../../scheduler/next-fire.ts";
import { inboundHookDeliveryRate } from "../../scheduler/workflow-automation-view.ts";
import {
  AuthorityEffectChangeSchema,
  AuthorityEffectChangesBaseSchema,
} from "../../workflows/authority-changes.ts";
import { reviewAuthorityEnvironments } from "../../workflows/authority-environments.ts";
import { AuthorityExecutionShapeSchema } from "../../workflows/authority-execution-shape.ts";
import { BoundaryGrowthSchema } from "../../workflows/authority-growth.ts";
import {
  approvalWouldCarry,
  boundaryGrowth,
  nameGrowth,
  referenceApprovedManifest,
} from "../../workflows/authority-inheritance.ts";
import {
  listEnabledScheduleBasis,
  observeAuthorityById,
  pageWorkflowAuthorityIds,
  reviewEffectChanges,
} from "../../workflows/authority-read.ts";
import { suggestAuthorityBounds } from "../../workflows/authority-suggestions.ts";
import { contentPublicationLabels } from "../../workflows/content-publication-proposal.ts";
import { readDatabaseNow } from "../../workflows/database-clock.ts";
import { WorkflowEffectManifestSchema } from "../../workflows/effect-manifest.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { defineOperation, type Rejection, type RejectionStatus, reject } from "./index.ts";

export const workflowParam = z.object({ id: z.string().uuid() });
export const authorityParam = workflowParam.extend({ authority_id: z.string().uuid() });
const versionParam = workflowParam.extend({ version_id: z.string().uuid() });

const authorityStates = [
  "approved",
  "not_yet_valid",
  "expired",
  "revoked",
  "superseded",
  "exhausted",
  "invalidated",
  "unavailable",
] as const;

export const authoritySchema = z
  .object({
    id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    effect_manifest_digest: z.string(),
    effect_manifest: WorkflowEffectManifestSchema,
    execution_environment: z.enum(["dev", "prod"]),
    target_constraints: z.object({ targets: z.array(z.string()) }),
    valid_from: z.string().datetime(),
    valid_until: z.string().datetime().nullable(),
    max_runs: z.number().int().nullable(),
    reserved_runs: z.number().int(),
    remaining_runs: z.number().int().nullable(),
    open_ended: z.boolean(),
    created_by: z.string().uuid(),
    created_at: z.string().datetime(),
    revoked_at: z.string().datetime().nullable(),
    revoked_by: z.string().uuid().nullable(),
    inherited_from: z.string().uuid().nullable(),
    superseded_by: z.string().uuid().nullable(),
    active_version: z.boolean(),
    ready_for_new_run: z.boolean(),
    live_test: z
      .object({
        state: z.enum(["not_requested", "blocked", "queued", "running", "succeeded", "failed"]),
        execution_id: z.string().uuid().optional(),
      })
      .optional(),
    state: z.enum(authorityStates),
  })
  .openapi("WorkflowExecutionAuthority");

type Authority = z.infer<typeof authoritySchema>;

const environmentAssessmentSchema = z
  .object({
    possible: z.boolean(),
    reasons: z.array(
      z.object({
        code: z.enum(ENVIRONMENT_BLOCK_CODES),
        step_id: z.string(),
        connector_id: z.string().nullable(),
        connector_name: z.string().nullable(),
      }),
    ),
  })
  .openapi("WorkflowAuthorityEnvironmentAssessment");

const previewSchema = z
  .object({
    manifest: WorkflowEffectManifestSchema,
    digest: z.string(),
    eligible_for_repeated_runs: z.boolean(),
    preparation_required: z.boolean().optional(),
    content_items: z.array(z.object({ id: z.string().uuid(), label: z.string() })).optional(),
    unavailable_steps: z.array(z.string()),
    tool_pins_compared: z.boolean().optional().openapi({
      description:
        "Present when the workflow calls MCP tools: whether each pinned tool description was compared with its server for this caller. It is only compared for a caller who may grant the approval.",
    }),
    unavailable_connectors: z
      .array(
        z.object({
          step_id: z.string(),
          connector_id: z.string().uuid(),
          connector_slug: z.string(),
          connector_name: z.string(),
          reason: z.enum(["disabled", "needs_reauth", "credential_unavailable"]),
        }),
      )
      .optional(),
    boundary_contradictions: z
      .array(
        z.object({
          step_id: z.string(),
          declared_prefix: z.string(),
          observed_key: z.string(),
          observed_at: z.string(),
        }),
      )
      .optional(),
    request_refusals: z
      .array(
        z.object({
          step_id: z.string(),
          reason: z.string(),
          call_path: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    storage_refusals: z
      .array(
        z.object({
          step_id: z.string(),
          reason: z.string(),
          call_path: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    execution_shape: AuthorityExecutionShapeSchema,
    boundary_growth: z.array(BoundaryGrowthSchema).optional(),
    effect_changes: z.array(AuthorityEffectChangeSchema).optional(),
    effect_changes_base: AuthorityEffectChangesBaseSchema.optional(),
    approval_carries_over: z.boolean(),
    environments: z.object({ dev: environmentAssessmentSchema, prod: environmentAssessmentSchema }),
    recommended_environment: z.object({
      environment: z.enum(["dev", "prod"]).nullable(),
      reason: z.enum(ENVIRONMENT_RECOMMENDATION_REASONS),
    }),
    schedules: z.array(
      z.object({ cron: z.string(), timezone: z.string(), next_run_at: z.string().nullable() }),
    ),
    suggested_bounds: z.object({
      valid_from: z.string().datetime(),
      valid_until: z.string().datetime(),
      max_runs: z.number().int(),
    }),
    suggested_bounds_basis: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("manual") }),
      z.object({ kind: z.literal("schedule"), scheduled_runs: z.number().int() }),
      z.object({
        kind: z.literal("hook"),
        scheduled_runs: z.number().int(),
        observed_deliveries: z.number().int(),
        observed_days: z.number().int(),
        minimum_applied: z.boolean(),
      }),
    ]),
  })
  .openapi("WorkflowAuthorityPreview");

const PreviewQuery = z.object({ environment: z.enum(["dev", "prod"]).default("dev") });

const ListQuery = z.object({
  environment: z.enum(["dev", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
});

const AuthorityList = z
  .object({
    items: z.array(authoritySchema),
    next_cursor: z.string().uuid().nullable(),
  })
  .openapi("WorkflowExecutionAuthorityList");

const FAILURE = "Invalid, unavailable or unauthorized authority boundary";

export const authorityFailures = {
  400: FAILURE,
  401: FAILURE,
  403: FAILURE,
  404: FAILURE,
  409: FAILURE,
};

export const AUTHORITY_DESCRIPTION =
  "Exact local authority; explicit activation promotes the reviewed draft atomically; a run starts only when start_run is set";

const AUTHORITY_ERROR_STATUSES: Record<string, RejectionStatus> = {
  workflow_version_unavailable: 404,
  authority_not_found: 404,
  human_session_required: 403,
  human_session_expired: 403,
  csrf_rejected: 403,
  authority_permission_denied: 403,
  authority_window_invalid: 400,
  authority_manifest_changed: 409,
  authority_activation_changed: 409,
  authority_effect_unbound: 409,
  mcp_tool_changed: 409,
  mcp_tool_unavailable: 409,
  authority_revoked: 409,
  authority_not_live: 409,
  authority_preparation_ambiguous: 409,
  authority_preparation_failed: 409,
  prepared_credential_unavailable: 409,
  input_schema_violation: 400,
};

export function authorityRejection(error: unknown): Rejection {
  const code = (error as { code?: unknown })?.code;
  const details = (error as { details?: unknown })?.details;
  const status = typeof code === "string" ? AUTHORITY_ERROR_STATUSES[code] : undefined;
  if (typeof code === "string" && status)
    return reject.status(
      status,
      code,
      (error as Error).message,
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined,
    );
  throw error;
}

export async function observeAuthority(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  authority_id: string,
): Promise<Authority | null> {
  const observed = await observeAuthorityById(db, tenant_id, workflow_id, authority_id);
  return observed ? authoritySchema.parse(observed) : null;
}

const authorityNotFound = () => reject.notFound("execution authority");

interface PreviewInput {
  readonly id: string;
  readonly version_id: string;
  readonly environment: "dev" | "prod";
}

export const previewWorkflowAuthorityOperation = defineOperation<
  PreviewInput,
  Record<string, unknown>
>({
  id: "workflows.authorities.preview",
  summary: "Review the exact locally resolved effect boundary without executing it",
  permission: "workflow:read",
  resource: { type: "workflow", param: "id" },
  effect: "read",
  async handler(scope, { id, version_id, environment }) {
    const db = scope.db;
    const tenant_id = scope.tenant_id;
    try {
      const human =
        scope.principal && scope.request
          ? await browserSessionForPrincipal(scope.request, scope.principal)
          : null;
      const mayGrant =
        scope.principal && human
          ? (
              await can(db, {
                tenant_id,
                principal: scope.principal,
                permission: "workflow:write",
                resource: { type: "workflow", id },
              })
            ).allow
          : false;
      const result = await previewWorkflowAuthority(
        {
          tenant_id,
          workflow_id: id,
          workflow_version_id: version_id,
          execution_environment: environment,
        },
        db,
        { include_review: true, compare_tool_pins: mayGrant },
      );
      if (!result.execution_shape) throw new Error("authority review unavailable");
      const now = await readDatabaseNow(db);
      const schedules = await listEnabledScheduleBasis(db, tenant_id, id, environment);
      const { basis, ...suggested_bounds } = suggestAuthorityBounds(
        now,
        schedules,
        environment === "prod" ? await inboundHookDeliveryRate(tenant_id, id, db, now) : null,
      );
      const reviewed = {
        tenant_id,
        workflow_id: id,
        workflow_version_id: version_id,
        execution_environment: environment,
      };
      const reference = await referenceApprovedManifest(db, reviewed);
      const boundary_growth = reference
        ? await nameGrowth(db, tenant_id, boundaryGrowth(reference, result.manifest))
        : null;
      const changes = await reviewEffectChanges(db, reviewed, reference, result.manifest);
      const approval_carries_over = await approvalWouldCarry(db, {
        tenant_id,
        workflow_id: id,
        version_id,
        execution_environment: reviewed.execution_environment,
      });
      const choice = await reviewAuthorityEnvironments(
        db,
        { tenant_id, workflow_id: id, workflow_version_id: version_id },
        now,
      );
      return {
        ...result,
        ...choice,
        ...(boundary_growth ? { boundary_growth } : {}),
        ...(changes ?? {}),
        approval_carries_over,
        execution_shape: result.execution_shape,
        content_items: contentPublicationLabels(
          result.manifest,
          schedules.map((schedule) => schedule.input),
        ),
        schedules: schedules.map((schedule) => ({
          cron: schedule.cron,
          timezone: schedule.timezone,
          next_run_at: nextScheduleFire(schedule, now),
        })),
        suggested_bounds,
        suggested_bounds_basis: basis,
      };
    } catch (error) {
      return authorityRejection(error);
    }
  },
  http: {
    method: "get",
    path: "/v1/workflows/{id}/versions/{version_id}/authority-preview",
    tags: ["workflows"],
    params: versionParam,
    query: PreviewQuery,
    response: previewSchema,
    success: { status: 200, description: "Read-only review with finite default bounds" },
    errors: authorityFailures,
    toInput: ({ param, query }) => ({
      ...(param as { id: string; version_id: string }),
      environment: (query as z.infer<typeof PreviewQuery>).environment,
    }),
    toBody: (review) => review,
  },
});

interface ListInput {
  readonly id: string;
  readonly query: z.infer<typeof ListQuery>;
}

export const listWorkflowAuthoritiesOperation = defineOperation<
  ListInput,
  z.infer<typeof AuthorityList>
>({
  id: "workflows.authorities.list",
  summary: "List bounded authority history with current eligibility and remaining runs",
  permission: "workflow:read",
  resource: { type: "workflow", param: "id" },
  effect: "read",
  async handler(scope, { id, query: { cursor, environment, limit } }) {
    const page = await pageWorkflowAuthorityIds(scope.db, {
      tenant_id: scope.tenant_id,
      workflow_id: id,
      cursor,
      environment,
      limit,
    });
    if (!page.ok) return reject.notFound(page.missing);
    const items: Authority[] = [];
    for (const authorityId of page.ids) {
      const authority = await observeAuthority(scope.db, scope.tenant_id, id, authorityId);
      if (!authority) return authorityNotFound();
      items.push(authority);
    }
    return { items, next_cursor: page.next_cursor };
  },
  http: {
    method: "get",
    path: "/v1/workflows/{id}/execution-authorities",
    tags: ["workflows"],
    params: workflowParam,
    query: ListQuery,
    response: AuthorityList,
    success: { status: 200, description: "Newest first; cursor is the last returned authority id" },
    errors: authorityFailures,
    toInput: ({ param, query }) => ({
      id: (param as { id: string }).id,
      query: query as z.infer<typeof ListQuery>,
    }),
    toBody: (page) => page,
  },
});

export const getWorkflowAuthorityOperation = defineOperation<
  { id: string; authority_id: string },
  Authority
>({
  id: "workflows.authorities.get",
  summary: "Read remaining runs, expiry and current effect binding",
  permission: "workflow:read",
  resource: { type: "workflow", param: "id" },
  effect: "read",
  async handler(scope, { id, authority_id }) {
    return (
      (await observeAuthority(scope.db, scope.tenant_id, id, authority_id)) ?? authorityNotFound()
    );
  },
  http: {
    method: "get",
    path: "/v1/workflows/{id}/execution-authorities/{authority_id}",
    tags: ["workflows"],
    params: authorityParam,
    response: authoritySchema,
    success: { status: 200, description: AUTHORITY_DESCRIPTION },
    errors: authorityFailures,
    toInput: ({ param }) => param as { id: string; authority_id: string },
    toBody: (authority) => authority,
  },
});
