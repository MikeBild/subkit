// Chat identity link CRUD (admin route).
//
// The chat dispatcher requires an *explicit* `chat_identities` row to
// map a platform user (Slack `U…`, Teams AAD id, …) to a subkit user.
// Unknown chat senders are rejected with a `chat.message.denied`
// audit row — there is no implicit elevation. The installing operator
// is linked at workspace install via
// `POST /v1/chat/workspaces.installer_platform_user_id`; every other
// chat user is linked here.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import { ChatPlatformZodEnum } from "../../chat/index.ts";
import { chatIdentities, chatWorkspaces, users } from "../../db/schema/index.ts";
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

function rowToOutput(row: typeof chatIdentities.$inferSelect): z.infer<typeof ChatIdentitySchema> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    // pgEnum already constrains the column to the three values; the
    // narrowing cast is the documented contract, not a wildcard.
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
    const db = c.get("db");
    const rows = await db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.tenant_id, principal.tenant_id));
    return c.json({ items: rows.map(rowToOutput) }, 200);
  });

  app.openapi(linkRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");

    // Verify `body.workspace_id` is a chat_workspaces row installed in
    // THIS tenant. The `chat_identities` unique key
    // (platform, workspace_id, platform_user_id) is GLOBAL — without
    // this check a T_A admin can insert a row keyed on T_B's team_id,
    // and when T_B later installs that workspace the dispatcher's
    // (platform, workspace_id, platform_user_id) lookup matches A's
    // row under tenant B (audit poisoning + cross-tenant actor on
    // every B-side message from that Slack user).
    const [ws] = await db
      .select({ id: chatWorkspaces.id })
      .from(chatWorkspaces)
      .where(
        and(
          eq(chatWorkspaces.tenant_id, principal.tenant_id),
          eq(chatWorkspaces.platform, body.platform),
          eq(chatWorkspaces.workspace_id, body.workspace_id),
        ),
      )
      .limit(1);
    if (!ws) throw new NotFoundError("chat_workspace");

    // Verify `body.user_id` exists in THIS tenant before linking. The
    // `chat_identities.user_id` FK only constrains existence — not
    // tenant — so without this check a T_A admin could insert a row
    // binding a real Slack user to a T_B user_id. RBAC still closes
    // the door at run time (`dispatcher.ts` preloads roles by
    // `(tenant_id, user_id)` and finds nothing), but the audit trail
    // would record the cross-tenant id as `actor_id` on every message
    // — the wrong identity to log a denied audit against.
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenant_id, principal.tenant_id), eq(users.id, body.user_id)))
      .limit(1);
    if (!user) throw new NotFoundError("user");

    // Insert + audit inside a tx so a process crash between the link
    // INSERT and the audit row can't strand a committed link with no
    // forensic trail (AGENTS.md: "Never bypass the audit log").
    let row: typeof chatIdentities.$inferSelect | undefined;
    await db.transaction(async (tx) => {
      const insertResult = await tx
        .insert(chatIdentities)
        .values({
          tenant_id: principal.tenant_id,
          user_id: body.user_id,
          platform: body.platform,
          workspace_id: body.workspace_id,
          platform_user_id: body.platform_user_id,
        })
        .onConflictDoNothing({
          target: [
            chatIdentities.platform,
            chatIdentities.workspace_id,
            chatIdentities.platform_user_id,
          ],
        })
        .returning();
      row = insertResult[0];
      if (!row) {
        throw new ConflictError(
          `chat user ${body.platform}:${body.workspace_id}:${body.platform_user_id} is already linked`,
        );
      }
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: "user",
          actor_id: principal.id,
          action: AuditAction.CHAT_IDENTITY_LINKED,
          resource_type: "chat_identity",
          resource_id: body.user_id,
          result: "success",
          metadata: {
            kind: "manual",
            platform: body.platform,
            platform_user_id: body.platform_user_id,
          },
        },
        tx,
      );
    });
    if (!row) throw new ConflictError("chat_identity link transaction produced no row");
    return c.json(rowToOutput(row), 201);
  });

  app.openapi(unlinkRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const [row] = await db
      .select()
      .from(chatIdentities)
      .where(and(eq(chatIdentities.tenant_id, principal.tenant_id), eq(chatIdentities.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError("chat_identity");
    // DELETE + audit inside a tx so a crash between them can't leave
    // a removed identity with no audit row.
    await db.transaction(async (tx) => {
      await tx
        .delete(chatIdentities)
        .where(and(eq(chatIdentities.tenant_id, principal.tenant_id), eq(chatIdentities.id, id)));
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: "user",
          actor_id: principal.id,
          action: AuditAction.CHAT_IDENTITY_UNLINKED,
          resource_type: "chat_identity",
          resource_id: row.user_id,
          result: "success",
          metadata: {
            kind: "manual_unlink",
            platform: row.platform,
            platform_user_id: row.platform_user_id,
          },
        },
        tx,
      );
    });
    return c.json({ deleted: true as const }, 200);
  });
}
