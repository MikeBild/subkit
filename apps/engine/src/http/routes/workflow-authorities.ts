import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ENVIRONMENT_BLOCK_CODES,
  ENVIRONMENT_RECOMMENDATION_REASONS,
} from "@shared/approval-choice.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { continueConversationDevLiveTest } from "../../conversations/index.ts";
import type { Executor } from "../../db/client.ts";
import { getBoss } from "../../queue/index.ts";
import { can } from "../../rbac/index.ts";
import {
  inboundHookAutomationView,
  inboundHookDeliveryRate,
  nextScheduleFire,
  workflowAutomationView,
} from "../../scheduler/index.ts";
import {
  ActivateWorkflowDraftSchema,
  AuthorityEffectChangeSchema,
  AuthorityEffectChangesBaseSchema,
  AuthorityExecutionShapeSchema,
  activateWorkflowDraft,
  approvalWouldCarry,
  BoundaryGrowthSchema,
  boundaryGrowth,
  contentPublicationLabels,
  GrantWorkflowAuthoritySchema,
  grantWorkflowAuthority,
  JsonValueSchema,
  listEnabledScheduleBasis,
  MakeWorkflowAuthorityUntilRevokedSchema,
  makeWorkflowAuthorityUntilRevoked,
  nameGrowth,
  observeAuthorityById,
  pageWorkflowAuthorityIds,
  prepareReportAuthority,
  previewWorkflowAuthority,
  readDatabaseNow,
  referenceApprovedManifest,
  reviewAuthorityEnvironments,
  reviewEffectChanges,
  revokeWorkflowAuthority,
  suggestAuthorityBounds,
  WorkflowEffectManifestSchema,
} from "../../workflows/index.ts";
import { HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const workflowParam = z.object({ id: z.string().uuid() });
const authorityParam = workflowParam.extend({ authority_id: z.string().uuid() });
const authoritySchema = z
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
    state: z.enum([
      "approved",
      "not_yet_valid",
      "expired",
      "revoked",
      "superseded",
      "exhausted",
      "invalidated",
      "unavailable",
    ]),
  })
  .openapi("WorkflowExecutionAuthority");
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
const failures = Object.fromEntries(
  [400, 401, 403, 404, 409].map((status) => [
    status,
    {
      description: "Invalid, unavailable or unauthorized authority boundary",
      content: { "application/json": { schema: ErrorSchema } },
    },
  ]),
);
const response = {
  description:
    "Exact local authority; explicit activation promotes the reviewed draft atomically; a run starts only when start_run is set",
  content: { "application/json": { schema: authoritySchema } },
};
const preview = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/versions/{version_id}/authority-preview",
  tags: ["workflows"],
  summary: "Review the exact locally resolved effect boundary without executing it",
  security: [{ bearerAuth: [] }],
  request: {
    params: workflowParam.extend({ version_id: z.string().uuid() }),
    query: z.object({ environment: z.enum(["dev", "prod"]).default("dev") }),
  },
  responses: {
    200: {
      description: "Read-only review with finite default bounds",
      content: { "application/json": { schema: previewSchema } },
    },
    ...failures,
  },
});
const automationStateSchema = z.enum([
  "paused",
  "activation_required",
  "input_required",
  "repair_required",
  "approval_required",
  "authorized",
  "verification_unavailable",
]);
const automationStatus = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/automation-status",
  tags: ["workflows"],
  summary: "Read verified readiness of this workflow's schedules and inbound hooks",
  security: [{ bearerAuth: [] }],
  request: { params: workflowParam },
  responses: {
    200: {
      description: "Current status, never a permission grant",
      content: {
        "application/json": {
          schema: z.object({
            schedules: z.array(
              z.object({
                schedule_id: z.string(),
                workflow_id: z.string(),
                state: automationStateSchema,
                ready: z.boolean(),
                cron: z.string(),
                timezone: z.string(),
                environment: z.enum(["dev", "prod"]),
                next_run_at: z.string().nullable(),
              }),
            ),
            inbound_hooks: z.array(
              z.object({
                inbound_hook_id: z.string(),
                workflow_id: z.string(),
                slug: z.string(),
                state: automationStateSchema,
                ready: z.boolean(),
                environment: z.literal("prod"),
                admission_hold: z
                  .object({
                    reason_code: z.enum([
                      "execution_authority_required",
                      "execution_authority_unavailable",
                    ]),
                    observed_at: z.string(),
                  })
                  .nullable(),
                last_refused_at: z.string().nullable(),
                last_refused_reason: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    ...failures,
  },
});
const prepareReport = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/versions/{version_id}/prepare-authority",
  tags: ["workflows"],
  summary: "Prepare a held report preview without granting permission or sending",
  security: [{ bearerAuth: [] }],
  request: {
    params: workflowParam.extend({ version_id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              environment: z.enum(["dev", "prod"]),
              input: JsonValueSchema.optional(),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Preparation completed; review the current boundary next",
      content: {
        "application/json": {
          schema: z.object({
            prepared: z.boolean(),
            reason: z.string().optional(),
            trigger: z.object({ kind: z.literal("inbound_hook"), slug: z.string() }).optional(),
            diagnoses: z
              .array(
                z.object({
                  code: z.string(),
                  reason: z.string().optional(),
                  step_id: z.string(),
                  remedy_kind: z.enum(["patch", "prepare", "declare", "reconnect", "author"]),
                  fixer: z.string().optional(),
                  candidate_id: z.string().optional(),
                }),
              )
              .optional(),
          }),
        },
      },
    },
    ...failures,
  },
});
const activateDraft = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/activate-draft",
  tags: ["workflows"],
  summary:
    "Activate a reviewed saved draft from a human browser without authorizing runs; a run starts only when start_run is set",
  security: [{ bearerAuth: [] }],
  request: {
    params: workflowParam,
    body: { content: { "application/json": { schema: ActivateWorkflowDraftSchema } } },
  },
  responses: {
    200: {
      description: "Activated without execution authority; no run starts unless start_run is set",
      content: {
        "application/json": {
          schema: z.object({
            workflow_version_id: z.string().uuid(),
            activated: z.literal(true),
            execution_authorized: z.literal(false),
            live_test: z.object({
              state: z.enum([
                "not_requested",
                "blocked",
                "queued",
                "running",
                "succeeded",
                "failed",
              ]),
              execution_id: z.string().uuid().optional(),
            }),
          }),
        },
      },
    },
    ...failures,
  },
});
const grant = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/execution-authorities",
  tags: ["workflows"],
  summary:
    "Grant a reviewed finite boundary from an authenticated human browser; no run starts unless start_run is set",
  security: [{ bearerAuth: [] }],
  request: {
    params: workflowParam,
    body: { content: { "application/json": { schema: GrantWorkflowAuthoritySchema } } },
  },
  responses: { 201: response, ...failures },
});
const get = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/execution-authorities/{authority_id}",
  tags: ["workflows"],
  summary: "Read remaining runs, expiry and current effect binding",
  security: [{ bearerAuth: [] }],
  request: { params: authorityParam },
  responses: { 200: response, ...failures },
});
const list = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/execution-authorities",
  tags: ["workflows"],
  summary: "List bounded authority history with current eligibility and remaining runs",
  security: [{ bearerAuth: [] }],
  request: {
    params: workflowParam,
    query: z.object({
      environment: z.enum(["dev", "prod"]).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().uuid().optional(),
    }),
  },
  responses: {
    200: {
      description: "Newest first; cursor is the last returned authority id",
      content: {
        "application/json": {
          schema: z
            .object({
              items: z.array(authoritySchema),
              next_cursor: z.string().uuid().nullable(),
            })
            .openapi("WorkflowExecutionAuthorityList"),
        },
      },
    },
    ...failures,
  },
});
const revoke = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/execution-authorities/{authority_id}/revoke",
  tags: ["workflows"],
  summary: "Revoke the exact execution authority from an authenticated human browser",
  security: [{ bearerAuth: [] }],
  request: { params: authorityParam },
  responses: { 200: response, ...failures },
});

const untilRevoked = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/execution-authorities/{authority_id}/until-revoked",
  tags: ["workflows"],
  summary:
    "Replace a time-limited approval with one until revoked for the identical boundary from an authenticated human browser",
  security: [{ bearerAuth: [] }],
  request: {
    params: authorityParam,
    body: {
      content: { "application/json": { schema: MakeWorkflowAuthorityUntilRevokedSchema } },
    },
  },
  responses: {
    200: {
      description:
        "The approval that now applies until revoked; the time-limited one is superseded in the same transaction",
      content: { "application/json": { schema: authoritySchema } },
    },
    ...failures,
  },
});

function translate(error: unknown): never {
  const code = (error as { code?: unknown })?.code;
  const statuses: Record<string, number> = {
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
    authority_revoked: 409,
    authority_not_live: 409,
    authority_preparation_ambiguous: 409,
    authority_preparation_failed: 409,
    prepared_credential_unavailable: 409,
    input_schema_violation: 400,
  };
  const details = (error as { details?: unknown })?.details;
  if (typeof code === "string" && statuses[code])
    throw new HttpError(
      statuses[code],
      code,
      (error as Error).message,
      details && typeof details === "object" && !Array.isArray(details)
        ? { details: details as Record<string, unknown> }
        : {},
    );
  throw error;
}

async function readAuthority(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  authority_id: string,
) {
  const observed = await observeAuthorityById(db, tenant_id, workflow_id, authority_id);
  if (!observed) throw new NotFoundError("execution authority");
  return authoritySchema.parse(observed);
}

export function registerWorkflowAuthorityRoutes(app: OpenAPIHono<AppEnv>): void {
  for (const path of [
    "/v1/workflows/:id/versions/:version_id/authority-preview",
    "/v1/workflows/:id/execution-authorities/:authority_id",
  ])
    app.use(
      path,
      requirePermission("workflow:read", (c) => ({
        type: "workflow",
        id: c.req.param("id") ?? "",
      })),
    );
  for (const path of [
    "/v1/workflows/:id/execution-authorities/:authority_id/revoke",
    "/v1/workflows/:id/execution-authorities/:authority_id/until-revoked",
  ])
    app.use(
      path,
      requirePermission("workflow:write", (c) => ({
        type: "workflow",
        id: c.req.param("id") ?? "",
      })),
    );
  const readAuthorities = requirePermission("workflow:read", (c) => ({
    type: "workflow",
    id: c.req.param("id") ?? "",
  }));
  const writeAuthority = requirePermission("workflow:write", (c) => ({
    type: "workflow",
    id: c.req.param("id") ?? "",
  }));
  app.use("/v1/workflows/:id/execution-authorities", (c, next) =>
    (c.req.method === "GET" ? readAuthorities : writeAuthority)(c, next),
  );
  app.use("/v1/workflows/:id/activate-draft", writeAuthority);
  app.use(
    "/v1/workflows/:id/versions/:version_id/prepare-authority",
    requirePermission("workflow:run", (c) => ({ type: "workflow", id: c.req.param("id") ?? "" })),
  );
  app.use("/v1/workflows/:id/versions/:version_id/prepare-authority", readAuthorities);
  app.use("/v1/workflows/:id/automation-status", readAuthorities);
  app.use("/v1/workflows/:id/automation-status", requirePermission("schedule:read"));
  app.openapi(automationStatus, async (c) => {
    const now = await readDatabaseNow(c.get("db"));
    const principal = requireAuth(c);
    const tenant = principal.tenant_id;
    const workflow = c.req.valid("param").id;
    const db = c.get("db");
    const probe = async (permission: "inbound_hook:read" | "audit:read") =>
      (await can(db, { tenant_id: tenant, principal, permission, quiet: true })).allow;
    return c.json(
      {
        schedules: await workflowAutomationView(tenant, workflow, db, now),
        inbound_hooks: (await probe("inbound_hook:read"))
          ? await inboundHookAutomationView(tenant, workflow, db, now, {
              refusal_reasons: await probe("audit:read"),
            })
          : [],
      },
      200,
    );
  });
  app.openapi(prepareReport, async (c) => {
    const principal = requireAuth(c);
    const { id, version_id } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const outcome = await prepareReportAuthority(
        {
          tenant_id: principal.tenant_id,
          workflow_id: id,
          workflow_version_id: version_id,
          execution_environment: body.environment,
          ...(body.input !== undefined ? { input: body.input } : {}),
        },
        c.get("db"),
        principal,
      );
      return c.json(outcome ?? { prepared: false, reason: "nothing_to_prepare" }, 200);
    } catch (error) {
      return translate(error);
    }
  });
  app.openapi(activateDraft, async (c) => {
    try {
      const principal = requireAuth(c);
      const body = c.req.valid("json");
      const activated = await activateWorkflowDraft(c.req.valid("param").id, body, {
        principal,
        request: c.req.raw,
        db: c.get("db"),
      });
      const live_test =
        body.start_run === true && body.execution_environment === "dev" && body.conversation_id
          ? await continueConversationDevLiveTest({
              db: c.get("db"),
              principal,
              boss: c.get("boss") ?? getBoss(),
              conversation_id: body.conversation_id,
              workflow_id: c.req.valid("param").id,
              workflow_version_id: activated.workflow_version_id,
            })
          : { state: "not_requested" as const };
      return c.json({ ...activated, live_test }, 200);
    } catch (error) {
      return translate(error);
    }
  });
  app.openapi(list, async (c) => {
    const { tenant_id } = requireAuth(c);
    const { id } = c.req.valid("param");
    const { cursor, environment, limit } = c.req.valid("query");
    const db = c.get("db");
    const page = await pageWorkflowAuthorityIds(db, {
      tenant_id,
      workflow_id: id,
      cursor,
      environment,
      limit,
    });
    if (!page.ok) throw new NotFoundError(page.missing);
    const items = [];
    for (const authorityId of page.ids)
      items.push(await readAuthority(db, tenant_id, id, authorityId));
    return c.json({ items, next_cursor: page.next_cursor }, 200);
  });
  app.openapi(preview, async (c) => {
    const principal = requireAuth(c);
    const { id, version_id } = c.req.valid("param");
    try {
      const result = await previewWorkflowAuthority(
        {
          tenant_id: principal.tenant_id,
          workflow_id: id,
          workflow_version_id: version_id,
          execution_environment: c.req.valid("query").environment,
        },
        c.get("db"),
        { include_review: true },
      );
      if (!result.execution_shape) throw new Error("authority review unavailable");
      const now = await readDatabaseNow(c.get("db"));
      const schedules = await listEnabledScheduleBasis(
        c.get("db"),
        principal.tenant_id,
        id,
        c.req.valid("query").environment,
      );
      const { basis, ...suggested_bounds } = suggestAuthorityBounds(
        now,
        schedules,
        c.req.valid("query").environment === "prod"
          ? await inboundHookDeliveryRate(principal.tenant_id, id, c.get("db"), now)
          : null,
      );
      const reviewed = {
        tenant_id: principal.tenant_id,
        workflow_id: id,
        workflow_version_id: version_id,
        execution_environment: c.req.valid("query").environment,
      };
      const reference = await referenceApprovedManifest(c.get("db"), reviewed);
      const boundary_growth = reference
        ? await nameGrowth(
            c.get("db"),
            principal.tenant_id,
            boundaryGrowth(reference, result.manifest),
          )
        : null;
      const changes = await reviewEffectChanges(c.get("db"), reviewed, reference, result.manifest);
      const approval_carries_over = await approvalWouldCarry(c.get("db"), {
        tenant_id: principal.tenant_id,
        workflow_id: id,
        version_id,
        execution_environment: reviewed.execution_environment,
      });
      const choice = await reviewAuthorityEnvironments(
        c.get("db"),
        { tenant_id: principal.tenant_id, workflow_id: id, workflow_version_id: version_id },
        now,
      );
      return c.json(
        {
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
        },
        200,
      );
    } catch (error) {
      return translate(error);
    }
  });
  app.openapi(grant, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    try {
      const row = await grantWorkflowAuthority(id, c.req.valid("json"), {
        principal,
        request: c.req.raw,
        db: c.get("db"),
      });
      const body = c.req.valid("json");
      const live_test =
        body.start_run === true && body.execution_environment === "dev" && body.conversation_id
          ? await continueConversationDevLiveTest({
              db: c.get("db"),
              principal,
              boss: c.get("boss") ?? getBoss(),
              conversation_id: body.conversation_id,
              workflow_id: id,
              workflow_version_id: row.workflow_version_id,
            })
          : { state: "not_requested" as const };
      return c.json(
        { ...(await readAuthority(c.get("db"), principal.tenant_id, id, row.id)), live_test },
        201,
      );
    } catch (error) {
      return translate(error);
    }
  });
  app.openapi(get, async (c) => {
    const principal = requireAuth(c);
    const { id, authority_id } = c.req.valid("param");
    return c.json(await readAuthority(c.get("db"), principal.tenant_id, id, authority_id), 200);
  });
  app.openapi(revoke, async (c) => {
    const principal = requireAuth(c);
    const { id, authority_id } = c.req.valid("param");
    try {
      await revokeWorkflowAuthority(id, authority_id, {
        principal,
        request: c.req.raw,
        db: c.get("db"),
      });
      return c.json(await readAuthority(c.get("db"), principal.tenant_id, id, authority_id), 200);
    } catch (error) {
      return translate(error);
    }
  });
  app.openapi(untilRevoked, async (c) => {
    const principal = requireAuth(c);
    const { id, authority_id } = c.req.valid("param");
    try {
      const row = await makeWorkflowAuthorityUntilRevoked(id, authority_id, c.req.valid("json"), {
        principal,
        request: c.req.raw,
        db: c.get("db"),
      });
      return c.json(await readAuthority(c.get("db"), principal.tenant_id, id, row.id), 200);
    } catch (error) {
      return translate(error);
    }
  });
}
