// Pending chat-space discovery (read-only).
//
// `GET /v1/chat/spaces/pending` lists the named spaces the caller added
// the app to but has not yet installed — the data `sk chat install-space`
// needs to offer a zero-typing picker. The heavy lifting (and the
// tenant-isolation guard) lives in the `chat` subsystem:
// `listPendingSpacesForPrincipal` (apps/engine/src/chat/pending-spaces.ts).
//
// Gated on `chat_workspace:read` — the same permission that lists
// installed workspaces. NOT routed through `/v1/audit-log` (whose
// `audit:read` is admin-only); a member who can install a workspace can
// discover a pending one. The caller only ever sees spaces attributable
// to their own verified identity — never raw SYSTEM audit rows.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import { ChatPlatformZodEnum, listPendingSpacesForPrincipal } from "../../chat/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const PendingChatSpaceSchema = z
  .object({
    platform: ChatPlatformZodEnum,
    /** Platform-native id — e.g. Google `spaces/<id>`. */
    workspace_id: z.string(),
    /** Human-friendly space name when the platform supplied one. */
    display_name: z.string().nullable(),
    /** The caller's own verified platform user id — pass verbatim as
     *  `installer_platform_user_id` to `POST /v1/chat/workspaces`. */
    installer_platform_user_id: z.string(),
  })
  .openapi("PendingChatSpace");

const PendingChatSpaceListResponse = z
  .object({ items: z.array(PendingChatSpaceSchema) })
  .openapi("PendingChatSpaceListResponse");

const PendingQuery = z.object({
  /** Narrow discovery to one platform. Non-global-id platforms
   *  (slack/teams) always return `[]` — they carry no attributable
   *  pre-install signal. */
  platform: ChatPlatformZodEnum.optional(),
});

const listPendingRoute = createRoute({
  method: "get",
  path: "/v1/chat/spaces/pending",
  tags: ["chat"],
  summary: "List spaces you added the app to but have not installed yet",
  security: [{ bearerAuth: [] }],
  request: { query: PendingQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: PendingChatSpaceListResponse } },
    },
  },
});

export function registerChatSpaceRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/chat/spaces/pending", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("chat_workspace:read")(c, next);
    return next();
  });

  app.openapi(listPendingRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { platform } = c.req.valid("query");
    const items = await listPendingSpacesForPrincipal(
      db,
      { tenant_id: principal.tenant_id, user_id: principal.id },
      platform ? { platform } : undefined,
    );
    return c.json({ items }, 200);
  });
}
