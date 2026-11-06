import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  ackNotificationInboxOperation,
  listNotificationInboxOperation,
  PRINCIPAL_NOT_USER,
  readerId,
} from "../../../api/operations/notification-inbox.ts";
import { markInboxRead, markInboxUnread } from "../../../notifications/index.ts";
import { HttpError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const MARK_MAX_IDS = 500;

const IdsBody = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(MARK_MAX_IDS),
  })
  .openapi("CliNotificationInboxIdsRequest");

const MarkReadResponse = z
  .object({ marked: z.number().int().nonnegative() })
  .openapi("CliNotificationInboxMarkReadResponse");

const MarkUnreadResponse = z
  .object({ unmarked: z.number().int().nonnegative() })
  .openapi("CliNotificationInboxMarkUnreadResponse");

const readRoute = createRoute({
  method: "post",
  path: "/v1/notifications/inbox/read",
  tags: ["notifications"],
  summary: "Mark specific inbox tasks read for this caller",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: IdsBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: MarkReadResponse } },
    },
    400: {
      description: "Principal is not a user",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const unreadRoute = createRoute({
  method: "post",
  path: "/v1/notifications/inbox/unread",
  tags: ["notifications"],
  summary: "Restore unread state on specific inbox tasks for this caller",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: IdsBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: MarkUnreadResponse } },
    },
    400: {
      description: "Principal is not a user",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

function requireReader(principal: { kind: string; id: string }): string {
  const uid = readerId(principal);
  if (!uid) throw new HttpError(400, "principal_not_user", PRINCIPAL_NOT_USER);
  return uid;
}

function gateOtherMethods(
  methods: readonly string[],
  gate: MiddlewareHandler<AppEnv>,
): MiddlewareHandler<AppEnv> {
  return (c, next) => (methods.includes(c.req.method) ? next() : gate(c, next));
}

export function registerInboxRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(
    "/v1/notifications/inbox",
    gateOtherMethods(["GET", "HEAD"], requirePermission("notification:read")),
  );
  app.use(
    "/v1/notifications/inbox/ack",
    gateOtherMethods(["POST"], requirePermission("notification:read")),
  );
  app.use("/v1/notifications/inbox/read", requirePermission("notification:read"));
  app.use("/v1/notifications/inbox/unread", requirePermission("notification:read"));

  toHonoRoute(app, listNotificationInboxOperation);
  toHonoRoute(app, ackNotificationInboxOperation);

  app.openapi(readRoute, async (c) => {
    const principal = requireAuth(c);
    const { ids } = c.req.valid("json");
    const userId = requireReader(principal);
    const marked = await markInboxRead(c.get("db"), principal.tenant_id, userId, ids);
    return c.json({ marked }, 200);
  });

  app.openapi(unreadRoute, async (c) => {
    const principal = requireAuth(c);
    const { ids } = c.req.valid("json");
    const userId = requireReader(principal);
    const unmarked = await markInboxUnread(c.get("db"), principal.tenant_id, userId, ids);
    return c.json({ unmarked }, 200);
  });
}
