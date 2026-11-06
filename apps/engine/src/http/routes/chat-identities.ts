import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import {
  assertChatWorkspaceOwnershipAvailable,
  ChatIdentityLinkRefusedError,
  type ChatIdentityRow,
  ChatPlatformZodEnum,
  linkChatIdentity,
  listChatIdentities,
  unlinkChatIdentity,
} from "../../chat/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ChatIdentitySchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    user_id: z.string().uuid(),
    platform: ChatPlatformZodEnum,
    workspace_id: z.string(),
    platform_user_id: z.string(),
    linked_at: z.string(),
  })
  .openapi("ChatIdentity");

const ChatIdentityListResponse = z
  .object({ items: z.array(ChatIdentitySchema) })
  .openapi("ChatIdentityListResponse");

const LinkChatIdentitySchema = z
  .object({
    platform: ChatPlatformZodEnum,
    workspace_id: z.string().min(1),
    platform_user_id: z.string().min(1),
    user_id: z.string().uuid(),
  })
  .openapi("LinkChatIdentity");

function mapLinkRefusal(err: unknown): never {
  if (err instanceof ChatIdentityLinkRefusedError) {
    if (err.refusal === "already_linked") throw new ConflictError(err.message);
    throw new NotFoundError(err.message);
  }
  throw err;
}

function rowToOutput(row: ChatIdentityRow): z.infer<typeof ChatIdentitySchema> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    platform: row.platform as "slack" | "teams" | "google_chat",
    workspace_id: row.workspace_id,
    platform_user_id: row.platform_user_id,
    linked_at: row.linked_at.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/v1/chat/identities",
  tags: ["chat"],
  summary: "List chat-user → subkit-user identity links in this tenant",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ChatIdentityListResponse } },
    },
  },
});

const linkRoute = createRoute({
  method: "post",
  path: "/v1/chat/identities",
  tags: ["chat"],
  summary: "Link a platform chat user to a subkit user",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: LinkChatIdentitySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Linked",
      content: { "application/json": { schema: ChatIdentitySchema } },
    },
    409: {
      description: "Already linked",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const unlinkRoute = createRoute({
  method: "delete",
  path: "/v1/chat/identities/{id}",
  tags: ["chat"],
  summary: "Unlink a chat identity",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "Unlinked",
      content: { "application/json": { schema: z.object({ deleted: z.literal(true) }) } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerChatIdentityRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/chat/identities", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("chat_identity:read")(c, next);
    if (c.req.method === "POST") return requirePermission("chat_identity:write")(c, next);
    return next();
  });
  app.use("/v1/chat/identities/:id", async (c, next) => {
    if (c.req.method === "DELETE") return requirePermission("chat_identity:write")(c, next);
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const rows = await listChatIdentities(c.get("db"), principal.tenant_id);
    return c.json({ items: rows.map(rowToOutput) }, 200);
  });

  app.openapi(linkRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    await assertChatWorkspaceOwnershipAvailable(db, principal.tenant_id);
    const body = c.req.valid("json");
    const row = await linkChatIdentity(db, { principal, body }).catch(mapLinkRefusal);
    if (!row) throw new ConflictError("chat_identity link transaction produced no row");
    return c.json(rowToOutput(row), 201);
  });

  app.openapi(unlinkRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    if (!(await unlinkChatIdentity(c.get("db"), principal, id))) {
      throw new NotFoundError("chat_identity");
    }
    return c.json({ deleted: true as const }, 200);
  });
}
