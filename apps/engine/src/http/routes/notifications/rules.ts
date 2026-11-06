import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import {
  createRule,
  deleteRule,
  listRules,
  type NotificationRuleRow,
  testRule,
  updateRule,
} from "../../../notifications/index.ts";
import { serviceMetadataFromHono } from "../../../observability/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

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

const listRoute = createRoute({
  method: "get",
  path: "/v1/notifications/rules",
  tags: ["notifications"],
  summary: "List notification rules",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RuleListResponse } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/notifications/rules",
  tags: ["notifications"],
  summary: "Create a notification rule",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateRuleBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: RuleSchema } } },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/v1/notifications/rules/{id}",
  tags: ["notifications"],
  summary: "Update a notification rule",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateRuleBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RuleSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/notifications/rules/{id}",
  tags: ["notifications"],
  summary: "Delete a notification rule",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const testRoute = createRoute({
  method: "post",
  path: "/v1/notifications/rules/:id/test",
  tags: ["notifications"],
  summary:
    "Synthesise a notification event and dispatch it through the rule pipeline. Returns the rule-matching, rate-limit, and channel-dispatch outcome so operators can verify a rule end-to-end without waiting for a real workflow run.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: TestRuleBody } } },
  },
  responses: {
    200: {
      description: "Dispatch outcome",
      content: { "application/json": { schema: TestRuleResponse } },
    },
    404: {
      description: "Rule not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerRuleRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/notifications/rules", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("notification:read")(c, next);
    if (c.req.method === "POST") return requirePermission("notification:write")(c, next);
    return next();
  });
  app.use("/v1/notifications/rules/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "PATCH" || c.req.method === "DELETE") {
      return requirePermission("notification:write", () => ({ type: "notification_rule", id }))(
        c,
        next,
      );
    }
    return next();
  });
  app.use("/v1/notifications/rules/:id/test", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "POST") {
      return requirePermission("notification:write", () => ({ type: "notification_rule", id }))(
        c,
        next,
      );
    }
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const rows = await listRules(c.get("db"), principal.tenant_id);
    return c.json({ items: rows.map(serializeRule) }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const row = await createRule(c.get("db"), principal, c.req.valid("json"));
    return c.json(serializeRule(row), 201);
  });

  app.openapi(updateRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const row = await updateRule(c.get("db"), principal, id, c.req.valid("json"));
    if (!row) throw new NotFoundError("notification_rule");
    return c.json(serializeRule(row), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const deleted = await deleteRule(c.get("db"), principal, id);
    if (!deleted) throw new NotFoundError("notification_rule");
    return c.json({ deleted: true }, 200);
  });

  app.openapi(testRoute, async (c) => {
    const meta = serviceMetadataFromHono(c);
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const result = await testRule(
      c.get("db"),
      {
        tenant_id: meta.tenant_id,
        actor_type: principal.kind,
        actor_id: meta.actor_id ?? principal.id,
        trace_id: meta.trace_id,
        request_source: meta.request_source,
      },
      id,
      c.req.valid("json"),
    );
    if (!result) throw new NotFoundError("notification_rule");
    return c.json(
      {
        matched: result.matched,
        delivered: result.delivered,
        outcomes: result.outcomes.map((o) => ({
          rule_id: o.rule_id,
          channel_id: o.channel_id,
          status: o.status,
          reason: o.reason ?? null,
          error: o.error ?? null,
        })),
      },
      200,
    );
  });
}
