import { z } from "@hono/zod-openapi";
import { AUDIT_SOURCE_HEADER, DEPLOY_VERSION_HEADER } from "@shared/audit-source.ts";
import { AuditSourceEnum, DeployVersionSchema } from "../../audit/audit-source.ts";
import { AuditAction } from "../../audit/types.ts";
import { writeSetting } from "../../runtime-config/settings-write.ts";
import { ErrorSchema } from "../common-schemas.ts";
import { defineOperation, plainRejection, reject } from "./index.ts";
import { SettingPathParam, SettingsTenantQuery } from "./settings.ts";

const PutBody = z
  .object({
    value: z.unknown(),
    force: z.boolean().optional(),
  })
  .openapi("SettingPutBody");

const PutHeaders = z.object({
  [AUDIT_SOURCE_HEADER]: AuditSourceEnum.optional(),
  [DEPLOY_VERSION_HEADER]: DeployVersionSchema.optional(),
});

const ValidationFailedSchema = z
  .object({
    code: z.literal("validation_failed"),
    message: z.string(),
    path: z.array(z.string()),
    expected: z.string(),
  })
  .openapi("SettingValidationFailed");

const ScopeViolationSchema = z
  .object({
    code: z.literal("scope_violation"),
    message: z.string(),
  })
  .openapi("SettingScopeViolation");

const OperatorRequiredSchema = z
  .object({
    code: z.literal("operator_required"),
    message: z.string(),
  })
  .openapi("SettingOperatorRequired");

const OperatorChangePendingSchema = z
  .object({
    code: z.literal("operator_change_pending"),
    message: z.string(),
  })
  .openapi("SettingOperatorChangePending");

const RestartRequiredSchema = z
  .object({
    code: z.literal("restart_required"),
    message: z.string(),
    requiresRestart: z.literal(true),
  })
  .openapi("SettingRestartRequired");

const PutSuccessSchema = z
  .object({
    value: z.unknown(),
    requiresRestart: z.boolean(),
  })
  .openapi("SettingPutResult");

interface SettingWriteInput {
  readonly path: string;
  readonly tenant: string | undefined;
  readonly value: unknown;
  readonly force: boolean | undefined;
  readonly auditSource: string | null;
  readonly deployVersion: string | null;
}

interface SettingWriteResult {
  readonly value: unknown;
  readonly requiresRestart: boolean;
}

export const putSettingOperation = defineOperation<SettingWriteInput, SettingWriteResult>({
  id: "settings.put",
  summary: "Write one leaf",
  permission: "settings:write",
  effect: "write",
  audit: AuditAction.SETTINGS_CHANGED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const outcome = await writeSetting({
      db: scope.db,
      principal,
      path: input.path,
      tenant: input.tenant,
      value: input.value,
      force: input.force ?? false,
      surface: "api",
      requestSource: scope.request_source ?? "api",
      auditSource: input.auditSource,
      deployVersion: input.deployVersion,
    });
    if (!outcome.ok)
      return plainRejection(outcome.status, outcome.code, outcome.message, outcome.details);
    return { value: outcome.value, requiresRestart: outcome.requiresRestart };
  },
  http: {
    method: "put",
    path: "/v1/settings/{path}",
    tags: ["settings"],
    security: null,
    params: SettingPathParam,
    query: SettingsTenantQuery,
    headers: PutHeaders,
    body: PutBody,
    response: PutSuccessSchema,
    success: { status: 200, description: "Setting written" },
    errors: {
      401: "Unauthorized",
      403: {
        description:
          "Scope violation, a write that needs the engine operator, or insufficient permissions",
        schema: z.union([ScopeViolationSchema, OperatorRequiredSchema]),
      },
      404: "Unknown leaf path",
      409: {
        description:
          "Setting requires a restart in production (pass force=true to apply), or a tenant write waits for the engine operator to activate saved engine-wide settings",
        schema: z.union([RestartRequiredSchema, OperatorChangePendingSchema, ErrorSchema]),
      },
      422: {
        description: "Validation failed against the leaf's Zod schema",
        schema: ValidationFailedSchema,
      },
    },
    toInput: ({ param, query, json, header }) => {
      const body = json as z.infer<typeof PutBody>;
      const headers = header as z.infer<typeof PutHeaders>;
      return {
        path: (param as z.infer<typeof SettingPathParam>).path,
        tenant: (query as z.infer<typeof SettingsTenantQuery>).tenant,
        value: body.value,
        force: body.force,
        auditSource: headers[AUDIT_SOURCE_HEADER] ?? null,
        deployVersion: headers[DEPLOY_VERSION_HEADER] ?? null,
      };
    },
    toBody: (result) => result,
  },
});
