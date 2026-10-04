import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ChatPlatformZodEnum, listPendingSpacesForPrincipal } from "../../chat/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const PendingChatSpaceSchema = z
  .object({
    platform: ChatPlatformZodEnum,
    workspace_id: z.string(),
    display_name: z.string().nullable(),
    installer_platform_user_id: z.string(),
  })
  .openapi("PendingChatSpace");

const PendingChatSpaceListResponse = z
  .object({ items: z.array(PendingChatSpaceSchema) })
  .openapi("PendingChatSpaceListResponse");

const PendingQuery = z.object({
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
