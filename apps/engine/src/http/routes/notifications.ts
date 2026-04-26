// P-GC5: notifications HTTP surface.
//
//   GET    /v1/notifications/channels
//   POST   /v1/notifications/channels
//   PATCH  /v1/notifications/channels/:id
//   DELETE /v1/notifications/channels/:id
//
//   GET    /v1/notifications/rules
//   POST   /v1/notifications/rules
//   PATCH  /v1/notifications/rules/:id
//   DELETE /v1/notifications/rules/:id
//
//   GET    /v1/notifications/deliveries?limit=&offset=&status=

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  type NotificationChannelRow,
  type NotificationRuleRow,
  notificationChannels,
  notificationDeliveries,
  notificationRules,
} from "../../db/schema/notifications.ts";
import { dispatchEvent } from "../../notifications/service.ts";
import { serviceMetadataFromHono } from "../../observability/service-metadata.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const SeverityEnum = z.enum(["debug", "info", "warn", "error", "critical"]);

// ----- channel schemas -----------------------------------------------------

const ChannelSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    workspace_id: z.string(),
    channel_id: z.string(),
    platform: z.string(),
    default_severity: z.string(),
    rate_limit_per_minute: z.number(),
    circuit_state: z.string(),
    circuit_open_until: z.string().nullable(),
    consecutive_failures: z.number(),
    active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("NotificationChannel");

const ChannelListResponse = z
  .object({ items: z.array(ChannelSchema) })
  .openapi("NotificationChannelListResponse");

const CreateChannelBody = z
  .object({
    workspace_id: z.string().min(1),
    channel_id: z.string().min(1),
    platform: z.string().min(1),
    default_severity: SeverityEnum.optional(),
    rate_limit_per_minute: z.number().int().positive().optional(),
    active: z.boolean().optional(),
  })
  .openapi("CreateNotificationChannelBody");

const UpdateChannelBody = z
  .object({
    default_severity: SeverityEnum.optional(),
    rate_limit_per_minute: z.number().int().positive().optional(),
    active: z.boolean().optional(),
  })
  .openapi("UpdateNotificationChannelBody");

// ----- rule schemas --------------------------------------------------------

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

// ----- delivery schema -----------------------------------------------------

const DeliverySchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    rule_id: z.string().nullable(),
    channel_id: z.string().nullable(),
    event_type: z.string(),
    severity: z.string(),
    status: z.string(),
    reason: z.string().nullable(),
    error: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("NotificationDelivery");

const DeliveryListResponse = z
  .object({ items: z.array(DeliverySchema) })
  .openapi("NotificationDeliveryListResponse");

const DeliveryQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  status: z.string().optional(),
});

// ----- serializers ---------------------------------------------------------

function serializeChannel(row: NotificationChannelRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    channel_id: row.channel_id,
    platform: row.platform,
    default_severity: row.default_severity,
    rate_limit_per_minute: row.rate_limit_per_minute,
    circuit_state: row.circuit_state,
    circuit_open_until: row.circuit_open_until ? row.circuit_open_until.toISOString() : null,
    consecutive_failures: row.consecutive_failures,
    active: row.active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

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

// ----- route definitions ---------------------------------------------------

const listChannelsRoute = createRoute({
  method: "get",
  path: "/v1/notifications/channels",
  tags: ["notifications"],
  summary: "List notification channels",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ChannelListResponse } },
    },
  },
});

const createChannelRoute = createRoute({
  method: "post",
  path: "/v1/notifications/channels",
  tags: ["notifications"],
  summary: "Create a notification channel",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateChannelBody } } } },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: ChannelSchema } },
    },
  },
});

const updateChannelRoute = createRoute({
  method: "patch",
  path: "/v1/notifications/channels/{id}",
  tags: ["notifications"],
  summary: "Update a notification channel",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateChannelBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ChannelSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteChannelRoute = createRoute({
  method: "delete",
  path: "/v1/notifications/channels/{id}",
  tags: ["notifications"],
  summary: "Delete a notification channel",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ deleted: z.boolean() }) },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listRulesRoute = createRoute({
  method: "get",
  path: "/v1/notifications/rules",
  tags: ["notifications"],
  summary: "List notification rules",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RuleListResponse } } },
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/v1/notifications/rules",
  tags: ["notifications"],
  summary: "Create a notification rule",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateRuleBody } } } },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: RuleSchema } },
    },
  },
});

const updateRuleRoute = createRoute({
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

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/v1/notifications/rules/{id}",
  tags: ["notifications"],
  summary: "Delete a notification rule",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ deleted: z.boolean() }) },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listDeliveriesRoute = createRoute({
  method: "get",
  path: "/v1/notifications/deliveries",
  tags: ["notifications"],
  summary: "List recent notification deliveries",
  security: [{ bearerAuth: [] }],
  request: { query: DeliveryQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DeliveryListResponse } },
    },
  },
});

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

const testRuleRoute = createRoute({
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

export function registerNotificationRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC gating: channels + rules + deliveries all live under
  // notification:read / notification:write.
  app.use("/v1/notifications/channels", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("notification:read")(c, next);
    if (c.req.method === "POST") return requirePermission("notification:write")(c, next);
    return next();
  });
  app.use("/v1/notifications/channels/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "PATCH" || c.req.method === "DELETE") {
      return requirePermission("notification:write", () => ({
        type: "notification_channel",
        id,
      }))(c, next);
    }
    return next();
  });
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
      // `:write` rather than `:read` because dispatching a synthetic
      // event causes a real outbound delivery (and a real audit row);
      // operators that only have read access should not be able to
      // trigger external messages.
      return requirePermission("notification:write", () => ({ type: "notification_rule", id }))(
        c,
        next,
      );
    }
    return next();
  });
  app.use("/v1/notifications/deliveries", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("notification:read")(c, next);
    return next();
  });

  app.openapi(listChannelsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rows = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.tenant_id, principal.tenant_id));
    return c.json({ items: rows.map(serializeChannel) }, 200);
  });

  app.openapi(createChannelRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const [row] = await db
      .insert(notificationChannels)
      .values({
        tenant_id: principal.tenant_id,
        workspace_id: body.workspace_id,
        channel_id: body.channel_id,
        platform: body.platform,
        default_severity: body.default_severity ?? "info",
        rate_limit_per_minute: body.rate_limit_per_minute ?? 60,
        active: body.active ?? true,
      })
      .returning();
    if (!row) throw new Error("notifications: insert failed");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.NOTIFICATION_CHANNEL_CREATED,
        resource_type: "notification_channel",
        resource_id: row.id,
        result: "success",
        metadata: {
          platform: row.platform,
          workspace_id: row.workspace_id,
          channel_id: row.channel_id,
        },
      },
      db,
    );
    return c.json(serializeChannel(row), 201);
  });

  app.openapi(updateChannelRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updates: Partial<NotificationChannelRow> = { updated_at: new Date() };
    if (body.default_severity !== undefined) updates.default_severity = body.default_severity;
    if (body.rate_limit_per_minute !== undefined)
      updates.rate_limit_per_minute = body.rate_limit_per_minute;
    if (body.active !== undefined) updates.active = body.active;
    const [row] = await db
      .update(notificationChannels)
      .set(updates)
      .where(
        and(
          eq(notificationChannels.tenant_id, principal.tenant_id),
          eq(notificationChannels.id, id),
        ),
      )
      .returning();
    if (!row) throw new NotFoundError("notification_channel");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.NOTIFICATION_CHANNEL_UPDATED,
        resource_type: "notification_channel",
        resource_id: row.id,
        result: "success",
        metadata: { changed_fields: Object.keys(updates).filter((k) => k !== "updated_at") },
      },
      db,
    );
    return c.json(serializeChannel(row), 200);
  });

  app.openapi(deleteChannelRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const deleted = await db
      .delete(notificationChannels)
      .where(
        and(
          eq(notificationChannels.tenant_id, principal.tenant_id),
          eq(notificationChannels.id, id),
        ),
      )
      .returning({ id: notificationChannels.id });
    if (deleted.length === 0) throw new NotFoundError("notification_channel");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.NOTIFICATION_CHANNEL_DELETED,
        resource_type: "notification_channel",
        resource_id: id,
        result: "success",
        metadata: {},
      },
      db,
    );
    return c.json({ deleted: true }, 200);
  });

  app.openapi(listRulesRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rows = await db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.tenant_id, principal.tenant_id));
    return c.json({ items: rows.map(serializeRule) }, 200);
  });

  app.openapi(createRuleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const [row] = await db
      .insert(notificationRules)
      .values({
        tenant_id: principal.tenant_id,
        name: body.name,
        event_pattern: body.event_pattern,
        workflow_pattern: body.workflow_pattern ?? "*",
        severity: body.severity ?? "info",
        request_source_filter: body.request_source_filter ?? null,
        target_workspace_id: body.target_workspace_id,
        target_channel_id: body.target_channel_id,
        active: body.active ?? true,
      })
      .returning();
    if (!row) throw new Error("notifications: rule insert failed");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.NOTIFICATION_RULE_CREATED,
        resource_type: "notification_rule",
        resource_id: row.id,
        result: "success",
        metadata: {
          name: row.name,
          event_pattern: row.event_pattern,
          severity: row.severity,
        },
      },
      db,
    );
    return c.json(serializeRule(row), 201);
  });

  app.openapi(updateRuleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updates: Partial<NotificationRuleRow> = { updated_at: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.event_pattern !== undefined) updates.event_pattern = body.event_pattern;
    if (body.workflow_pattern !== undefined) updates.workflow_pattern = body.workflow_pattern;
    if (body.severity !== undefined) updates.severity = body.severity;
    if (body.request_source_filter !== undefined)
      updates.request_source_filter = body.request_source_filter;
    if (body.target_workspace_id !== undefined)
      updates.target_workspace_id = body.target_workspace_id;
    if (body.target_channel_id !== undefined) updates.target_channel_id = body.target_channel_id;
    if (body.active !== undefined) updates.active = body.active;
    const [row] = await db
      .update(notificationRules)
      .set(updates)
      .where(
        and(eq(notificationRules.tenant_id, principal.tenant_id), eq(notificationRules.id, id)),
      )
      .returning();
    if (!row) throw new NotFoundError("notification_rule");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.NOTIFICATION_RULE_UPDATED,
        resource_type: "notification_rule",
        resource_id: row.id,
        result: "success",
        metadata: { changed_fields: Object.keys(updates).filter((k) => k !== "updated_at") },
      },
      db,
    );
    return c.json(serializeRule(row), 200);
  });

  app.openapi(deleteRuleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const deleted = await db
      .delete(notificationRules)
      .where(
        and(eq(notificationRules.tenant_id, principal.tenant_id), eq(notificationRules.id, id)),
      )
      .returning({ id: notificationRules.id });
    if (deleted.length === 0) throw new NotFoundError("notification_rule");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.NOTIFICATION_RULE_DELETED,
        resource_type: "notification_rule",
        resource_id: id,
        result: "success",
        metadata: {},
      },
      db,
    );
    return c.json({ deleted: true }, 200);
  });

  app.openapi(listDeliveriesRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const limit = Math.min(q.limit ?? 50, 500);
    const offset = q.offset ?? 0;
    const whereClauses = [eq(notificationDeliveries.tenant_id, principal.tenant_id)];
    if (q.status) {
      whereClauses.push(eq(notificationDeliveries.status, q.status));
    }
    const rows = await db
      .select()
      .from(notificationDeliveries)
      .where(whereClauses.length === 1 ? whereClauses[0] : and(...whereClauses))
      .orderBy(desc(notificationDeliveries.created_at))
      .limit(limit)
      .offset(offset);
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          tenant_id: r.tenant_id,
          rule_id: r.rule_id,
          channel_id: r.channel_id,
          event_type: r.event_type,
          severity: r.severity,
          status: r.status,
          reason: r.reason,
          error: r.error,
          created_at: r.created_at.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(testRuleRoute, async (c) => {
    const meta = serviceMetadataFromHono(c);
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const [rule] = await db
      .select()
      .from(notificationRules)
      .where(and(eq(notificationRules.tenant_id, meta.tenant_id), eq(notificationRules.id, id)))
      .limit(1);
    if (!rule) throw new NotFoundError("notification_rule");
    const event = {
      tenant_id: meta.tenant_id,
      type: body.event_type,
      workflow_id: body.workflow_id ?? null,
      workflow_slug: body.workflow_slug ?? null,
      severity: (body.severity ?? rule.severity) as
        | "debug"
        | "info"
        | "warn"
        | "error"
        | "critical",
      payload: body.payload ?? null,
    };
    const result = await dispatchEvent(
      {
        db,
        // No adapter resolver: tests must not send real platform
        // messages by default. Operators that wire a registry-backed
        // resolver into the router can pass it through here in a
        // follow-up. The dispatch still records the would-be delivery
        // row and audit entry, so the test result is meaningful.
      },
      event,
    );
    await auditAwait(
      {
        tenant_id: meta.tenant_id,
        actor_type: principal.kind,
        actor_id: meta.actor_id ?? principal.id,
        action: AuditAction.NOTIFICATION_RULE_TESTED,
        resource_type: "notification_rule",
        resource_id: rule.id,
        result: "success",
        metadata: {
          matched: result.matched,
          delivered: result.delivered,
          event_type: event.type,
          trace_id: meta.trace_id,
          request_source: meta.request_source,
        },
      },
      db,
    );
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
