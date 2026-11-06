import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import {
  createRule,
  deleteRule,
  listRules,
  type NotificationRuleRow,
  testRule,
  updateRule,
} from "../../notifications/admin/rules.ts";
import type { DispatchResult } from "../../notifications/service.ts";
import { mintTraceId } from "../../observability/service-metadata.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const SeverityEnum = z.enum(["debug", "info", "warn", "error", "critical"]);

const RuleSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    name: z.string(),
    event_pattern: z.string(),
    workflow_pattern: z.string(),
    severity: z.string(),
    request_source_filter: z.array(z.string()).nullable(),
    target_workspace_id: z.string(),
    target_channel_id: z.string(),
    active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("NotificationRule");

const RuleListResponse = z
  .object({ items: z.array(RuleSchema) })
  .openapi("NotificationRuleListResponse");

const CreateRuleBody = z
  .object({
    name: z.string().min(1),
    event_pattern: z.string().min(1),
    workflow_pattern: z.string().optional(),
    severity: SeverityEnum.optional(),
    request_source_filter: z.array(z.string()).nullable().optional(),
    target_workspace_id: z.string().min(1),
    target_channel_id: z.string().min(1),
    active: z.boolean().optional(),
  })
  .openapi("CreateNotificationRuleBody");

const UpdateRuleBody = z
  .object({
    name: z.string().min(1).optional(),
    event_pattern: z.string().min(1).optional(),
    workflow_pattern: z.string().optional(),
    severity: SeverityEnum.optional(),
    request_source_filter: z.array(z.string()).nullable().optional(),
    target_workspace_id: z.string().min(1).optional(),
    target_channel_id: z.string().min(1).optional(),
    active: z.boolean().optional(),
  })
  .openapi("UpdateNotificationRuleBody");

const TestRuleBody = z
  .object({
    event_type: z.string().min(1).default("notifications.test"),
    workflow_id: z.string().nullable().optional(),
    workflow_slug: z.string().nullable().optional(),
    severity: SeverityEnum.optional(),
    payload: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("TestNotificationRuleBody");

const TestRuleResponse = z
  .object({
    matched: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    outcomes: z.array(
      z.object({
        rule_id: z.string(),
        channel_id: z.string(),
        status: z.string(),
        reason: z.string().nullable().optional(),
        error: z.string().nullable().optional(),
      }),
    ),
  })
  .openapi("TestNotificationRuleResponse");

type CreateInput = z.infer<typeof CreateRuleBody>;
type TestFields = z.infer<typeof TestRuleBody>;
type UpdateFields = z.infer<typeof UpdateRuleBody>;

interface IdInput {
  readonly id: string;
}

interface UpdateInput extends IdInput {
  readonly body: UpdateFields;
}

interface TestInput extends IdInput {
  readonly body: TestFields;
}

const RULE_RESOURCE = { type: "notification_rule", param: "id" } as const;

function serializeRule(row: NotificationRuleRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    event_pattern: row.event_pattern,
    workflow_pattern: row.workflow_pattern,
    severity: row.severity,
    request_source_filter: Array.isArray(row.request_source_filter)
      ? (row.request_source_filter as string[])
      : null,
    target_workspace_id: row.target_workspace_id,
    target_channel_id: row.target_channel_id,
    active: row.active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function idFrom(param: unknown): IdInput {
  return { id: (param as IdInput).id };
}

export const listNotificationRulesOperation = defineOperation<
  Record<string, never>,
  NotificationRuleRow[]
>({
  id: "notification_rule.list",
  summary: "List notification rules",
  permission: "notification:read",
  effect: "read",
  handler: (scope) => listRules(scope.db, scope.tenant_id),
  http: {
    method: "get",
    path: "/v1/notifications/rules",
    tags: ["notifications"],
    response: RuleListResponse,
    toInput: () => ({}),
    toBody: (rows) => ({ items: rows.map(serializeRule) }),
  },
});

export const createNotificationRuleOperation = defineOperation<CreateInput, NotificationRuleRow>({
  id: "notification_rule.create",
  summary: "Create a notification rule",
  permission: "notification:write",
  effect: "write",
  audit: AuditAction.NOTIFICATION_RULE_CREATED,
  async handler(scope, body) {
    if (!scope.principal) return reject.unauthorized();
    return await createRule(scope.db, scope.principal, body);
  },
  http: {
    method: "post",
    path: "/v1/notifications/rules",
    tags: ["notifications"],
    body: CreateRuleBody,
    response: RuleSchema,
    success: { status: 201, description: "Created" },
    toInput: ({ json }) => json as CreateInput,
    toBody: serializeRule,
  },
});

export const updateNotificationRuleOperation = defineOperation<UpdateInput, NotificationRuleRow>({
  id: "notification_rule.update",
  summary: "Update a notification rule",
  permission: "notification:write",
  resource: RULE_RESOURCE,
  effect: "write",
  audit: AuditAction.NOTIFICATION_RULE_UPDATED,
  async handler(scope, { id, body }) {
    if (!scope.principal) return reject.unauthorized();
    const row = await updateRule(scope.db, scope.principal, id, body);
    return row ?? reject.notFound("notification_rule");
  },
  http: {
    method: "patch",
    path: "/v1/notifications/rules/{id}",
    tags: ["notifications"],
    params: IdParam,
    body: UpdateRuleBody,
    response: RuleSchema,
    errors: { 404: "Not found" },
    toInput: ({ param, json }) => ({ ...idFrom(param), body: json as UpdateFields }),
    toBody: serializeRule,
  },
});

export const deleteNotificationRuleOperation = defineOperation<IdInput, { deleted: true }>({
  id: "notification_rule.delete",
  summary: "Delete a notification rule",
  permission: "notification:write",
  resource: RULE_RESOURCE,
  effect: "write",
  audit: AuditAction.NOTIFICATION_RULE_DELETED,
  async handler(scope, { id }) {
    if (!scope.principal) return reject.unauthorized();
    const deleted = await deleteRule(scope.db, scope.principal, id);
    return deleted ? { deleted: true } : reject.notFound("notification_rule");
  },
  http: {
    method: "delete",
    path: "/v1/notifications/rules/{id}",
    tags: ["notifications"],
    params: IdParam,
    response: z.object({ deleted: z.boolean() }),
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (result) => result,
  },
});

export const testNotificationRuleOperation = defineOperation<TestInput, DispatchResult>({
  id: "notification_rule.test",
  summary:
    "Synthesise a notification event and dispatch it through the rule pipeline. Returns the rule-matching, rate-limit, and channel-dispatch outcome so operators can verify a rule end-to-end without waiting for a real workflow run.",
  permission: "notification:write",
  resource: RULE_RESOURCE,
  effect: "write",
  audit: AuditAction.NOTIFICATION_RULE_TESTED,
  async handler(scope, { id, body }) {
    if (!scope.principal) return reject.unauthorized();
    const result = await testRule(
      scope.db,
      {
        tenant_id: scope.tenant_id,
        actor_type: scope.principal.kind,
        actor_id: scope.principal.id,
        trace_id: scope.trace_id ?? mintTraceId(),
        request_source: scope.request_source ?? "api",
      },
      id,
      body,
    );
    return result ?? reject.notFound("notification_rule");
  },
  http: {
    method: "post",
    path: "/v1/notifications/rules/:id/test",
    tags: ["notifications"],
    params: IdParam,
    body: TestRuleBody,
    response: TestRuleResponse,
    success: { status: 200, description: "Dispatch outcome" },
    errors: { 404: "Rule not found" },
    toInput: ({ param, json }) => ({ ...idFrom(param), body: json as TestFields }),
    toBody: (result) => ({
      matched: result.matched,
      delivered: result.delivered,
      outcomes: result.outcomes.map((o) => ({
        rule_id: o.rule_id,
        channel_id: o.channel_id,
        status: o.status,
        reason: o.reason ?? null,
        error: o.error ?? null,
      })),
    }),
  },
});
