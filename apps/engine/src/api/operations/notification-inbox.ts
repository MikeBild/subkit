import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { ackInbox, listInbox } from "../../notifications/admin/inbox.ts";
import { defineOperation, isRejection, type Rejection, reject } from "./index.ts";

const INBOX_MAX_LIMIT = 500;

const InboxItemSchema = z
  .object({
    id: z.number(),
    severity: z.string(),
    event_type: z.string(),
    event_payload: z.unknown().nullable(),
    actionable: z.boolean(),
    resource_type: z.string().nullable(),
    resource_id: z.string().nullable(),
    read: z.boolean(),
    read_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("CliNotificationInboxItem");

const InboxListResponse = z
  .object({
    items: z.array(InboxItemSchema),
    cursor: z.number(),
    unread_count: z.number().int().nonnegative(),
    actionable_unread_count: z.number().int().nonnegative(),
  })
  .openapi("CliNotificationInboxListResponse");

const BoolQuery = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();

const InboxQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(INBOX_MAX_LIMIT).optional(),
  unread_only: BoolQuery,
  actionable_only: BoolQuery,
});

const AckBody = z
  .object({
    up_to_cursor: z.number().int().nonnegative(),
  })
  .openapi("CliNotificationInboxAckRequest");

const AckResponse = z
  .object({
    acked: z.number().int().nonnegative(),
  })
  .openapi("CliNotificationInboxAckResponse");

type InboxQueryInput = z.infer<typeof InboxQuery>;
type InboxPage = Awaited<ReturnType<typeof listInbox>>;

interface InboxListResult {
  readonly page: InboxPage;
  readonly since: number;
}

export function readerId(principal: { kind: string; id: string }): string | null {
  return principal.kind === "user" ? principal.id : null;
}

export const PRINCIPAL_NOT_USER =
  "read state is per user; this principal is a system account and has no inbox of its own";

function reader(
  principal: ResolvedPrincipal | null,
): { principal: ResolvedPrincipal; id: string } | Rejection {
  if (!principal) return reject.unauthorized();
  const id = readerId(principal);
  return id ? { principal, id } : reject.status(400, "principal_not_user", PRINCIPAL_NOT_USER);
}

export const listNotificationInboxOperation = defineOperation<InboxQueryInput, InboxListResult>({
  id: "notification_inbox.list",
  summary: "List inbox tasks with this caller's read state",
  permission: "notification:read",
  effect: "read",
  async handler(scope, q) {
    if (!scope.principal) return reject.unauthorized();
    const since = q.since ?? 0;
    const page = await listInbox(scope.db, scope.tenant_id, readerId(scope.principal), {
      since,
      limit: Math.min(q.limit ?? 100, INBOX_MAX_LIMIT),
      unread_only: q.unread_only,
      actionable_only: q.actionable_only,
    });
    return { page, since };
  },
  http: {
    method: "get",
    path: "/v1/notifications/inbox",
    tags: ["notifications"],
    query: InboxQuery,
    response: InboxListResponse,
    toInput: ({ query }) => query as InboxQueryInput,
    toBody: ({ page, since }) => {
      const rows = page.rows;
      const cursor = rows.length > 0 ? (rows[rows.length - 1]?.id ?? since) : since;
      return {
        items: rows.map((r) => ({
          id: r.id,
          severity: r.severity,
          event_type: r.event_type,
          event_payload: r.event_payload ?? null,
          actionable: r.actionable,
          resource_type: r.resource_type,
          resource_id: r.resource_id,
          read: r.read_at !== null,
          read_at: r.read_at?.toISOString() ?? null,
          created_at: r.created_at.toISOString(),
        })),
        cursor,
        unread_count: page.unread,
        actionable_unread_count: page.actionable_unread,
      };
    },
  },
});

export const ackNotificationInboxOperation = defineOperation<
  z.infer<typeof AckBody>,
  { acked: number }
>({
  id: "notification_inbox.ack",
  summary: "Mark this caller's inbox tasks read up to a cursor",
  permission: "notification:read",
  effect: "write",
  audit: AuditAction.SK_CLI_INBOX_ACKED,
  async handler(scope, { up_to_cursor }) {
    const caller = reader(scope.principal);
    if (isRejection(caller)) return caller;
    return { acked: await ackInbox(scope.db, caller.principal, caller.id, up_to_cursor) };
  },
  http: {
    method: "post",
    path: "/v1/notifications/inbox/ack",
    tags: ["notifications"],
    body: AckBody,
    response: AckResponse,
    errors: { 400: "Principal is not a user" },
    toInput: ({ json }) => json as z.infer<typeof AckBody>,
    toBody: (result) => result,
  },
});
