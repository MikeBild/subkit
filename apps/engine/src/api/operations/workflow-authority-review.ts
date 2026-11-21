import { z } from "@hono/zod-openapi";
import { REPAIR_REMEDIES } from "@shared/error-taxonomy.ts";
import { AuditAction } from "../../audit/types.ts";
import { can } from "../../rbac/evaluator.ts";
import {
  inboundHookAutomationView,
  workflowAutomationView,
} from "../../scheduler/workflow-automation-view.ts";
import { readDatabaseNow } from "../../workflows/database-clock.ts";
import { prepareReportAuthority } from "../../workflows/prepare-report-authority.ts";
import { JsonValueSchema } from "../../workflows/types.ts";
import { defineOperation, reject } from "./index.ts";
import { authorityFailures, authorityRejection, workflowParam } from "./workflow-authorities.ts";

const automationStateSchema = z.enum([
  "paused",
  "activation_required",
  "input_required",
  "repair_required",
  "approval_required",
  "authorized",
  "verification_unavailable",
]);

const AutomationStatusSchema = z.object({
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
          reason_code: z.enum(["execution_authority_required", "execution_authority_unavailable"]),
          observed_at: z.string(),
        })
        .nullable(),
      last_refused_at: z.string().nullable(),
      last_refused_reason: z.string().nullable(),
    }),
  ),
});

type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

export const workflowAutomationStatusOperation = defineOperation<{ id: string }, AutomationStatus>({
  id: "workflows.automation_status",
  summary: "Read verified readiness of this workflow's schedules and inbound hooks",
  permission: "workflow:read",
  resource: { type: "workflow", param: "id" },
  requiredPermissions: [{ permission: "schedule:read" }],
  effect: "read",
  async handler(scope, { id }) {
    const now = await readDatabaseNow(scope.db);
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const probe = async (permission: "inbound_hook:read" | "audit:read") =>
      (await can(scope.db, { tenant_id: scope.tenant_id, principal, permission, quiet: true }))
        .allow;
    return {
      schedules: await workflowAutomationView(scope.tenant_id, id, scope.db, now),
      inbound_hooks: (await probe("inbound_hook:read"))
        ? await inboundHookAutomationView(scope.tenant_id, id, scope.db, now, {
            refusal_reasons: await probe("audit:read"),
          })
        : [],
    };
  },
  http: {
    method: "get",
    path: "/v1/workflows/{id}/automation-status",
    tags: ["workflows"],
    params: workflowParam,
    response: AutomationStatusSchema,
    success: { status: 200, description: "Current status, never a permission grant" },
    errors: authorityFailures,
    toInput: ({ param }) => param as { id: string },
    toBody: (status) => status,
  },
});

const PrepareBody = z
  .object({
    environment: z.enum(["dev", "prod"]),
    input: JsonValueSchema.optional(),
  })
  .strict();

const PreparedSchema = z.object({
  prepared: z.boolean(),
  reason: z.string().optional(),
  trigger: z.object({ kind: z.literal("inbound_hook"), slug: z.string() }).optional(),
  diagnoses: z
    .array(
      z.object({
        code: z.string(),
        reason: z.string().optional(),
        step_id: z.string(),
        remedy_kind: z.enum(REPAIR_REMEDIES),
        fixer: z.string().optional(),
        candidate_id: z.string().optional(),
      }),
    )
    .optional(),
});

interface PrepareInput {
  readonly id: string;
  readonly version_id: string;
  readonly body: z.infer<typeof PrepareBody>;
}

type Prepared = NonNullable<Awaited<ReturnType<typeof prepareReportAuthority>>>;

export const prepareReportAuthorityOperation = defineOperation<
  PrepareInput,
  Prepared | { prepared: false; reason: "nothing_to_prepare" }
>({
  id: "workflows.authorities.prepare",
  summary: "Prepare a held report preview without granting permission or sending",
  permission: "workflow:run",
  resource: { type: "workflow", param: "id" },
  requiredPermissions: [
    { permission: "workflow:read", resource: { type: "workflow", param: "id" } },
  ],
  effect: "write",
  audit: AuditAction.EXECUTION_QUEUED,
  async handler(scope, { id, version_id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      const outcome = await prepareReportAuthority(
        {
          tenant_id: scope.tenant_id,
          workflow_id: id,
          workflow_version_id: version_id,
          execution_environment: body.environment,
          ...(body.input !== undefined ? { input: body.input } : {}),
        },
        scope.db,
        principal,
      );
      return outcome ?? { prepared: false, reason: "nothing_to_prepare" };
    } catch (error) {
      return authorityRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/workflows/{id}/versions/{version_id}/prepare-authority",
    tags: ["workflows"],
    params: workflowParam.extend({ version_id: z.string().uuid() }),
    body: PrepareBody,
    response: PreparedSchema,
    success: {
      status: 200,
      description: "Preparation completed; review the current boundary next",
    },
    errors: authorityFailures,
    toInput: ({ param, json }) => ({
      ...(param as { id: string; version_id: string }),
      body: json as z.infer<typeof PrepareBody>,
    }),
    toBody: (outcome) => outcome,
  },
});
