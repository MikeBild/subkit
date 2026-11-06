import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import {
  createChannel,
  deleteChannel,
  listChannels,
  type NotificationChannelRow,
  updateChannel,
} from "../../notifications/admin/channels.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

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

type CreateInput = z.infer<typeof CreateChannelBody>;
type UpdateFields = z.infer<typeof UpdateChannelBody>;

interface IdInput {
  readonly id: string;
}

interface UpdateInput extends IdInput {
  readonly body: UpdateFields;
}

const CHANNEL_RESOURCE = { type: "notification_channel", param: "id" } as const;

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

function idFrom(param: unknown): IdInput {
  return { id: (param as IdInput).id };
}

export const listNotificationChannelsOperation = defineOperation<
  Record<string, never>,
  NotificationChannelRow[]
>({
  id: "notification_channel.list",
  summary: "List notification channels",
  permission: "notification:read",
  effect: "read",
  handler: (scope) => listChannels(scope.db, scope.tenant_id),
  http: {
    method: "get",
    path: "/v1/notifications/channels",
    tags: ["notifications"],
    response: ChannelListResponse,
    toInput: () => ({}),
    toBody: (rows) => ({ items: rows.map(serializeChannel) }),
  },
});

export const createNotificationChannelOperation = defineOperation<
  CreateInput,
  NotificationChannelRow
>({
  id: "notification_channel.create",
  summary: "Create a notification channel",
  permission: "notification:write",
  effect: "write",
  audit: AuditAction.NOTIFICATION_CHANNEL_CREATED,
  async handler(scope, body) {
    if (!scope.principal) return reject.unauthorized();
    return await createChannel(scope.db, scope.principal, body);
  },
  http: {
    method: "post",
    path: "/v1/notifications/channels",
    tags: ["notifications"],
    body: CreateChannelBody,
    response: ChannelSchema,
    success: { status: 201, description: "Created" },
    toInput: ({ json }) => json as CreateInput,
    toBody: serializeChannel,
  },
});

export const updateNotificationChannelOperation = defineOperation<
  UpdateInput,
  NotificationChannelRow
>({
  id: "notification_channel.update",
  summary: "Update a notification channel",
  permission: "notification:write",
  resource: CHANNEL_RESOURCE,
  effect: "write",
  audit: AuditAction.NOTIFICATION_CHANNEL_UPDATED,
  async handler(scope, { id, body }) {
    if (!scope.principal) return reject.unauthorized();
    const row = await updateChannel(scope.db, scope.principal, id, body);
    return row ?? reject.notFound("notification_channel");
  },
  http: {
    method: "patch",
    path: "/v1/notifications/channels/{id}",
    tags: ["notifications"],
    params: IdParam,
    body: UpdateChannelBody,
    response: ChannelSchema,
    errors: { 404: "Not found" },
    toInput: ({ param, json }) => ({ ...idFrom(param), body: json as UpdateFields }),
    toBody: serializeChannel,
  },
});

export const deleteNotificationChannelOperation = defineOperation<IdInput, { deleted: true }>({
  id: "notification_channel.delete",
  summary: "Delete a notification channel",
  permission: "notification:write",
  resource: CHANNEL_RESOURCE,
  effect: "write",
  audit: AuditAction.NOTIFICATION_CHANNEL_DELETED,
  async handler(scope, { id }) {
    if (!scope.principal) return reject.unauthorized();
    const deleted = await deleteChannel(scope.db, scope.principal, id);
    return deleted ? { deleted: true } : reject.notFound("notification_channel");
  },
  http: {
    method: "delete",
    path: "/v1/notifications/channels/{id}",
    tags: ["notifications"],
    params: IdParam,
    response: z.object({ deleted: z.boolean() }),
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (result) => result,
  },
});
