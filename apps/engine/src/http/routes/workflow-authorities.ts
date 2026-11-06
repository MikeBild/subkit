import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  AUTHORITY_DESCRIPTION,
  authorityFailures,
  authorityParam,
  authorityRejection,
  authoritySchema,
  getWorkflowAuthorityOperation,
  listWorkflowAuthoritiesOperation,
  observeAuthority,
  previewWorkflowAuthorityOperation,
  workflowParam,
} from "../../api/operations/workflow-authorities.ts";
import { continueConversationDevLiveTest } from "../../conversations/index.ts";
import type { Executor } from "../../db/client.ts";
import { getBoss } from "../../queue/index.ts";
import { can } from "../../rbac/index.ts";
import { inboundHookAutomationView, workflowAutomationView } from "../../scheduler/index.ts";
import {
  ActivateWorkflowDraftSchema,
  activateWorkflowDraft,
  GrantWorkflowAuthoritySchema,
  grantWorkflowAuthority,
  JsonValueSchema,
  MakeWorkflowAuthorityUntilRevokedSchema,
  makeWorkflowAuthorityUntilRevoked,
  prepareReportAuthority,
  readDatabaseNow,
  revokeWorkflowAuthority,
} from "../../workflows/index.ts";
import { HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const failures = Object.fromEntries(
  Object.entries(authorityFailures).map(([status, description]) => [
    status,
    { description, content: { "application/json": { schema: ErrorSchema } } },
  ]),
);
const response = {
  description: AUTHORITY_DESCRIPTION,
  content: { "application/json": { schema: authoritySchema } },
};
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
  const refused = authorityRejection(error);
  throw new HttpError(
    refused.status,
    refused.code,
    refused.message,
    refused.details ? { details: refused.details } : {},
  );
}

async function readAuthority(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  authority_id: string,
) {
  const observed = await observeAuthority(db, tenant_id, workflow_id, authority_id);
  if (!observed) throw new NotFoundError("execution authority");
  return observed;
}

export function registerWorkflowAuthorityRoutes(app: OpenAPIHono<AppEnv>): void {
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
    c.req.method === "POST" ? writeAuthority(c, next) : next(),
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
  toHonoRoute(app, listWorkflowAuthoritiesOperation);
  toHonoRoute(app, previewWorkflowAuthorityOperation);
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
  toHonoRoute(app, getWorkflowAuthorityOperation);
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
