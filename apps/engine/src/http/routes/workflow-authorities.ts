import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ErrorSchema } from "../../api/common-schemas.ts";
import type { Db } from "../../db/client.ts";
import {
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { can } from "../../rbac/index.ts";
import {
  inboundHookAutomationView,
  nextScheduleFire,
  workflowAutomationView,
} from "../../scheduler/index.ts";
import {
  ActivateWorkflowDraftSchema,
  AuthorityExecutionShapeSchema,
  activateWorkflowDraft,
  contentBoundariesFromManifest,
  contentPublicationLabels,
  GrantWorkflowAuthoritySchema,
  grantWorkflowAuthority,
  prepareReportAuthority,
  previewWorkflowAuthority,
  reportBoundariesFromManifest,
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
    valid_until: z.string().datetime(),
    max_runs: z.number().int(),
    reserved_runs: z.number().int(),
    remaining_runs: z.number().int(),
    created_by: z.string().uuid(),
    created_at: z.string().datetime(),
    revoked_at: z.string().datetime().nullable(),
    revoked_by: z.string().uuid().nullable(),
    active_version: z.boolean(),
    ready_for_new_run: z.boolean(),
    state: z.enum([
      "approved",
      "not_yet_valid",
      "expired",
      "revoked",
      "exhausted",
      "invalidated",
      "unavailable",
    ]),
  })
  .openapi("WorkflowExecutionAuthority");
const previewSchema = z
  .object({
    manifest: WorkflowEffectManifestSchema,
    digest: z.string(),
    eligible_for_repeated_runs: z.boolean(),
    preparation_required: z.boolean().optional(),
    content_items: z.array(z.object({ id: z.string().uuid(), label: z.string() })).optional(),
    unavailable_steps: z.array(z.string()),
    // Why a declared folder was refused, in the terms a human can act on: the
    // key the step really wrote and the folder that does not contain it. The
    // manifest carries only the issue code; without this the reviewer is told
    // that something changed and not what.
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
    // Why a boundary was refused, in the engine's own words. The manifest
    // carries one blanket code per step — `dynamic_request` for every http
    // refusal — and the reader was shown that instead: "where this request goes
    // is decided at runtime" for a step whose path is a constant, whose real
    // refusal was that a stricter profile already reviews it. Reported here
    // rather than inside the manifest on purpose: this is repair evidence and
    // the digest must not depend on it, which is also why surfacing it cannot
    // invalidate a live approval.
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
    schedules: z.array(
      z.object({ cron: z.string(), timezone: z.string(), next_run_at: z.string().nullable() }),
    ),
    suggested_bounds: z.object({
      valid_from: z.string().datetime(),
      valid_until: z.string().datetime(),
      max_runs: z.number().int(),
    }),
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
    "Exact local authority; explicit activation promotes the reviewed draft atomically; never enqueues a run",
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
            /** The other thing that starts runs without a person. Same states
             *  as a schedule; a hook's deliveries always run in production.
             *  Empty unless the caller holds `inbound_hook:read`. */
            inbound_hooks: z.array(
              z.object({
                inbound_hook_id: z.string(),
                workflow_id: z.string(),
                slug: z.string(),
                state: automationStateSchema,
                ready: z.boolean(),
                environment: z.literal("prod"),
                /** Set while the authority gate refuses its deliveries; cleared
                 *  by an admitted delivery or a grant. Null on a deactivated
                 *  hook, which receives nothing. */
                admission_hold: z
                  .object({
                    reason_code: z.enum([
                      "execution_authority_required",
                      "execution_authority_unavailable",
                    ]),
                    observed_at: z.string(),
                  })
                  .nullable(),
                /** The newest refused delivery, from the audit trail, whatever
                 *  refused it (signature, authority, lifecycle), within the last
                 *  30 days. The reason is audit-log content: null unless the
                 *  caller holds `audit:read`. */
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
        "application/json": { schema: z.object({ environment: z.enum(["dev", "prod"]) }).strict() },
      },
    },
  },
  responses: {
    200: {
      description: "Preparation completed; review the current boundary next",
      content: {
        "application/json": {
          // `false` with a reason, not a blanket `true`: the caller was told a
          // preparation had run when nothing had, and the derivation that
          // depended on it then reported the steps as never executed.
          schema: z.object({
            prepared: z.boolean(),
            reason: z.string().optional(),
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
    "Activate a reviewed saved draft from a human browser without authorizing or starting runs",
  security: [{ bearerAuth: [] }],
  request: {
    params: workflowParam,
    body: { content: { "application/json": { schema: ActivateWorkflowDraftSchema } } },
  },
  responses: {
    200: {
      description: "Activated without execution authority",
      content: {
        "application/json": {
          schema: z.object({
            workflow_version_id: z.string().uuid(),
            activated: z.literal(true),
            execution_authorized: z.literal(false),
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
  summary: "Grant a reviewed finite boundary from an authenticated human browser",
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
    authority_preparation_ambiguous: 409,
    authority_preparation_failed: 409,
  };
  if (typeof code === "string" && statuses[code])
    throw new HttpError(statuses[code], code, (error as Error).message);
  throw error;
}

async function readAuthority(db: Db, tenant_id: string, workflow_id: string, authority_id: string) {
  const [row] = await db
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, workflow_id),
        eq(workflowExecutionAuthorities.id, authority_id),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("execution authority");
  const [workflow] = await db
    .select({
      lifecycle: workflows.lifecycle,
      current_version_id: workflows.current_version_id,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const active_version =
    workflow?.lifecycle === "active" && workflow.current_version_id === row.workflow_version_id;
  const clock = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  const now = clock.rows[0]?.now;
  if (!now) throw new Error("database clock unavailable");
  let state: z.infer<typeof authoritySchema>["state"] = row.revoked_at
    ? "revoked"
    : row.valid_until <= new Date(now)
      ? "expired"
      : row.reserved_runs >= row.max_runs
        ? "exhausted"
        : row.valid_from > new Date(now)
          ? "not_yet_valid"
          : "approved";
  if (state === "approved" || state === "not_yet_valid") {
    try {
      const current = await previewWorkflowAuthority(
        {
          tenant_id,
          workflow_id,
          workflow_version_id: row.workflow_version_id,
          execution_environment: row.execution_environment,
        },
        db,
        {
          report_boundaries: reportBoundariesFromManifest(row.effect_manifest),
          content_boundaries: contentBoundariesFromManifest(row.effect_manifest),
        },
      );
      if (current.digest !== row.effect_manifest_digest) state = "invalidated";
      else if (!current.eligible_for_repeated_runs) state = "unavailable";
    } catch (error) {
      if ((error as { code?: string }).code !== "workflow_version_unavailable") throw error;
      state = "invalidated";
    }
  }
  return authoritySchema.parse({
    ...row,
    state,
    active_version,
    ready_for_new_run: active_version && state === "approved",
    remaining_runs: Math.max(0, row.max_runs - row.reserved_runs),
    valid_from: row.valid_from.toISOString(),
    valid_until: row.valid_until.toISOString(),
    created_at: row.created_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
  });
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
  for (const path of ["/v1/workflows/:id/execution-authorities/:authority_id/revoke"])
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
    const clock = await c.get("db").execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    const now = clock.rows[0]?.now;
    if (!now) throw new Error("database clock unavailable");
    const principal = requireAuth(c);
    const tenant = principal.tenant_id;
    const workflow = c.req.valid("param").id;
    const db = c.get("db");
    // The route is gated for schedules. Hooks carry their own read permission,
    // and a refusal's reason is audit-log content: a caller sees each only
    // with the permission that already covers it elsewhere.
    const probe = async (permission: "inbound_hook:read" | "audit:read") =>
      (await can(db, { tenant_id: tenant, principal, permission, quiet: true })).allow;
    return c.json(
      {
        schedules: await workflowAutomationView(tenant, workflow, db, new Date(now)),
        inbound_hooks: (await probe("inbound_hook:read"))
          ? await inboundHookAutomationView(tenant, workflow, db, new Date(now), {
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
    try {
      const outcome = await prepareReportAuthority(
        {
          tenant_id: principal.tenant_id,
          workflow_id: id,
          workflow_version_id: version_id,
          execution_environment: c.req.valid("json").environment,
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
      return c.json(
        await activateWorkflowDraft(c.req.valid("param").id, c.req.valid("json"), {
          principal: requireAuth(c),
          request: c.req.raw,
          db: c.get("db"),
        }),
        200,
      );
    } catch (error) {
      return translate(error);
    }
  });
  app.openapi(list, async (c) => {
    const { tenant_id } = requireAuth(c);
    const { id } = c.req.valid("param");
    const { cursor, environment, limit } = c.req.valid("query");
    const db = c.get("db");
    const [workflow] = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id), isNull(workflows.deleted_at)),
      )
      .limit(1);
    if (!workflow) throw new NotFoundError("workflow");
    const filter = and(
      eq(workflowExecutionAuthorities.workflow_id, id),
      environment ? eq(workflowExecutionAuthorities.execution_environment, environment) : undefined,
    );
    if (cursor) {
      const [found] = await db
        .select({ id: workflowExecutionAuthorities.id })
        .from(workflowExecutionAuthorities)
        .where(
          and(
            eq(workflowExecutionAuthorities.tenant_id, tenant_id),
            filter,
            eq(workflowExecutionAuthorities.id, cursor),
          ),
        )
        .limit(1);
      if (!found) throw new NotFoundError("authority cursor");
    }
    // Keep the timestamp in PostgreSQL: converting a microsecond timestamp to
    // a JS Date before the keyset comparison could silently skip history rows.
    const anchor = db
      .select({
        created_at: workflowExecutionAuthorities.created_at,
        id: workflowExecutionAuthorities.id,
      })
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, tenant_id),
          filter,
          eq(workflowExecutionAuthorities.id, cursor ?? "00000000-0000-0000-0000-000000000000"),
        ),
      );
    const rows = await db
      .select({ id: workflowExecutionAuthorities.id })
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, tenant_id),
          filter,
          cursor
            ? sql`(${workflowExecutionAuthorities.created_at}, ${workflowExecutionAuthorities.id}) < (${anchor})`
            : undefined,
        ),
      )
      .orderBy(desc(workflowExecutionAuthorities.created_at), desc(workflowExecutionAuthorities.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const items = [];
    for (const row of page) items.push(await readAuthority(db, tenant_id, id, row.id));
    return c.json(
      { items, next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null },
      200,
    );
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
      const clock = await c.get("db").execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
      const now = clock.rows[0]?.now;
      if (!now) throw new Error("database clock unavailable");
      const schedules = await c
        .get("db")
        .select({
          cron: workflowsSchedules.cron,
          timezone: workflowsSchedules.timezone,
          input: workflowsSchedules.input,
          last_enqueued_at: workflowsSchedules.last_enqueued_at,
          created_at: workflowsSchedules.created_at,
        })
        .from(workflowsSchedules)
        .where(
          and(
            eq(workflowsSchedules.tenant_id, principal.tenant_id),
            eq(workflowsSchedules.workflow_id, id),
            eq(workflowsSchedules.paused, false),
            eq(workflowsSchedules.execution_mode, c.req.valid("query").environment),
          ),
        );
      return c.json(
        {
          ...result,
          execution_shape: result.execution_shape,
          content_items: contentPublicationLabels(
            result.manifest,
            schedules.map((schedule) => schedule.input),
          ),
          schedules: schedules.map((schedule) => ({
            cron: schedule.cron,
            timezone: schedule.timezone,
            next_run_at: nextScheduleFire(schedule, new Date(now)),
          })),
          suggested_bounds: suggestAuthorityBounds(new Date(now), schedules),
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
      return c.json(await readAuthority(c.get("db"), principal.tenant_id, id, row.id), 201);
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
}
