// Notification channels — REST surface.
//
//   GET    /v1/notifications/channels
//   POST   /v1/notifications/channels
//   PATCH  /v1/notifications/channels/{id}
//   DELETE /v1/notifications/channels/{id}
//
// Phase 4 of the 2026-05 architecture audit (issue #92): split out of
// the former http/routes/notifications.ts god-file into its own
// sub-resource module. Schemas live next to the routes that use them
// — same Zod-first contract; the only structural change is locality.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import {
  type NotificationChannelRow,
  notificationChannels,
} from "../../../db/schema/notifications.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const SeverityEnum = z.enum(["debug", "info", "warn", "error", "critical"]);

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

export function serializeChannel(row: NotificationChannelRow) {
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

const listRoute = createRoute({
  method: "get",
  path: "/v1/notifications/channels",
  tags: ["notifications"],
  summary: "List notification channels",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ChannelListResponse } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/notifications/channels",
  tags: ["notifications"],
  summary: "Create a notification channel",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateChannelBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ChannelSchema } } },
  },
});

const updateRoute = createRoute({
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

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/notifications/channels/{id}",
  tags: ["notifications"],
  summary: "Delete a notification channel",
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

export function registerChannelRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/notifications/channels", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("notification:read")(c, next);
    if (c.req.method === "POST") return requirePermission("notification:write")(c, next);
    return next();
  });
  app.use("/v1/notifications/channels/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "PATCH" || c.req.method === "DELETE") {
      return requirePermission("notification:write", () => ({ type: "notification_channel", id }))(
        c,
        next,
      );
    }
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rows = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.tenant_id, principal.tenant_id));
    return c.json({ items: rows.map(serializeChannel) }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
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

  app.openapi(updateRoute, async (c) => {
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

  app.openapi(deleteRoute, async (c) => {
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
}
