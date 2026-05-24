// Chat workspace install / list / remove.
//
// This is the multi-tenant binding for a chat platform: one
// `chat_workspaces` row maps one external workspace (a Slack `team_id`,
// future Teams `tenant_id`, future Google Chat space) to exactly one
// subkit tenant via the authenticated principal's `tenant_id`.
//
// On install we also seed a `chat_identities` row for the operator's
// own platform user id → the authenticated subkit user, so the
// installer is *linked* from their first chat message and the
// dispatcher doesn't reject them as "not linked" (see chat/dispatcher's
// explicit-linking model). Additional users are linked via the
// /v1/chat/identities admin route.
//
// The signing secret for Slack is engine config
// (`platform.slack.signing_secret`) — one subkit app installed across
// many workspaces; the per-workspace bot token lives here.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { AuditAction, audit } from "../../audit/index.ts";
import { type ChatAdapterRegistry, SlackAdapter } from "../../chat/index.ts";
import { getConfig } from "../../config/loader.ts";
import { encryptSecret } from "../../crypto/aes-gcm.ts";
import { chatIdentities, chatWorkspaces } from "../../db/schema/index.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ChatPlatformEnum = z.enum(["slack", "teams", "google_chat"]).openapi("ChatPlatform");

const ChatWorkspaceSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    platform: ChatPlatformEnum,
    /** Platform-native id (Slack `team_id`, Teams `tenant_id`, etc.). */
    workspace_id: z.string(),
    default_channel: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("ChatWorkspace");

const ChatWorkspaceListResponse = z
  .object({ items: z.array(ChatWorkspaceSchema) })
  .openapi("ChatWorkspaceListResponse");

const InstallChatWorkspaceSchema = z
  .object({
    platform: ChatPlatformEnum,
    /** Platform-native workspace id. Slack: `team_id` (T…). */
    workspace_id: z.string().min(1),
    /** Bot User OAuth Token for Slack (`xoxb-…`). For Teams / Google
     *  Chat the same field holds the platform's bot credential; those
     *  platforms are not yet hydrated and the install accepts the
     *  string for forward-compat. */
    bot_token: z.string().min(1),
    /** The installing operator's platform user id (Slack `U…`). Linked
     *  to the authenticated subkit user via `chat_identities` so the
     *  operator's first chat message resolves to a real principal
     *  instead of being rejected as "not linked". */
    installer_platform_user_id: z.string().min(1),
    /** Optional default channel (e.g. for notifications dispatch). */
    default_channel: z.string().nullable().optional(),
  })
  .openapi("InstallChatWorkspace");

function rowToOutput(row: typeof chatWorkspaces.$inferSelect): z.infer<typeof ChatWorkspaceSchema> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    platform: row.platform as "slack" | "teams" | "google_chat",
    workspace_id: row.workspace_id,
    default_channel: row.default_channel,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** AAD shape — mirrors `webhooks/inbound/service.ts aadFor` and
 *  `chat/hydrate.ts`. */
function aadFor(tenant_id: string, workspace_row_id: string): string {
  return `chat-workspace:${tenant_id}:${workspace_row_id}`;
}

const installRoute = createRoute({
  method: "post",
  path: "/v1/chat/workspaces",
  tags: ["chat"],
  summary: "Install a chat workspace (Slack / Teams / Google Chat)",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: InstallChatWorkspaceSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Installed",
      content: { "application/json": { schema: ChatWorkspaceSchema } },
    },
    400: {
      description: "Validation error or duplicate install",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/v1/chat/workspaces",
  tags: ["chat"],
  summary: "List chat workspaces installed in this tenant",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ChatWorkspaceListResponse } },
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/chat/workspaces/{id}",
  tags: ["chat"],
  summary: "Remove a chat workspace install",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "Removed",
      content: { "application/json": { schema: z.object({ deleted: z.literal(true) }) } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export interface ChatWorkspaceRoutesDeps {
  /** The same registry used by the chat ingestion routes and the
   *  chat.event worker. Install registers an adapter live (no reboot);
   *  DELETE evicts. */
  registry: ChatAdapterRegistry;
}

export function registerChatWorkspaceRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ChatWorkspaceRoutesDeps,
): void {
  app.use("/v1/chat/workspaces", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("chat_workspace:read")(c, next);
    if (c.req.method === "POST") return requirePermission("chat_workspace:write")(c, next);
    return next();
  });
  app.use("/v1/chat/workspaces/:id", async (c, next) => {
    if (c.req.method === "DELETE") return requirePermission("chat_workspace:write")(c, next);
    return next();
  });

  app.openapi(installRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");

    if (body.platform === "slack") {
      const signingSecret = getConfig().platform.slack.signing_secret ?? "";
      if (!signingSecret) {
        throw new BadRequestError(
          "engine config platform.slack.signing_secret is empty — set it before installing a Slack workspace",
        );
      }
    }

    // Insert with a placeholder ciphertext, then re-encrypt with the
    // row-bound AAD now that we have the row id. Mirrors the webhooks/
    // inbound install flow which faces the same "AAD needs the row id"
    // dance. The placeholder is overwritten in the same transaction so
    // a crash between the two steps cannot leave a usable but unbound
    // secret on disk.
    const placeholder = encryptSecret("__placeholder__");
    const insertResult = await db
      .insert(chatWorkspaces)
      .values({
        tenant_id: principal.tenant_id,
        platform: body.platform,
        workspace_id: body.workspace_id,
        default_channel: body.default_channel ?? null,
        bot_ciphertext: placeholder.ciphertext,
        bot_iv: placeholder.iv,
        bot_auth_tag: placeholder.auth_tag,
      })
      .onConflictDoNothing({
        target: [chatWorkspaces.tenant_id, chatWorkspaces.platform, chatWorkspaces.workspace_id],
      })
      .returning();
    const row = insertResult[0];
    if (!row) {
      throw new ConflictError(
        `${body.platform} workspace ${body.workspace_id} is already installed in this tenant`,
      );
    }

    // Re-encrypt with the row-bound AAD, then update.
    const bound = encryptSecret(body.bot_token, aadFor(row.tenant_id, row.id));
    await db
      .update(chatWorkspaces)
      .set({
        bot_ciphertext: bound.ciphertext,
        bot_iv: bound.iv,
        bot_auth_tag: bound.auth_tag,
        updated_at: new Date(),
      })
      .where(eq(chatWorkspaces.id, row.id));

    // Link the installer's platform user → the authenticated subkit
    // user so the operator's first chat message resolves to a real
    // principal. `onConflictDoNothing` because the operator may
    // already have linked themselves to another workspace under the
    // same tenant.
    await db
      .insert(chatIdentities)
      .values({
        tenant_id: principal.tenant_id,
        user_id: principal.id,
        platform: body.platform,
        workspace_id: body.workspace_id,
        platform_user_id: body.installer_platform_user_id,
      })
      .onConflictDoNothing({
        target: [
          chatIdentities.platform,
          chatIdentities.workspace_id,
          chatIdentities.platform_user_id,
        ],
      });

    audit(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.CHAT_WORKSPACE_INSTALLED,
        resource_type: "chat_workspace",
        resource_id: row.id,
        result: "success",
        metadata: {
          platform: body.platform,
          workspace_id: body.workspace_id,
        },
      },
      db,
    );
    audit(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.CHAT_IDENTITY_LINKED,
        resource_type: "chat_identity",
        resource_id: principal.id,
        result: "success",
        metadata: {
          kind: "install",
          platform: body.platform,
          platform_user_id: body.installer_platform_user_id,
        },
      },
      db,
    );

    // Register the adapter live so the next inbound event finds it
    // without waiting for a reboot. Only Slack is hydrated today; the
    // Teams / Google branches stay silent here on purpose (their
    // activation is separate later work).
    if (body.platform === "slack") {
      const signingSecret = getConfig().platform.slack.signing_secret;
      const adapter = new SlackAdapter({
        signingSecret,
        botToken: body.bot_token,
      });
      deps.registry.register(
        {
          tenant_id: row.tenant_id,
          platform: "slack",
          workspace_id: row.workspace_id,
        },
        adapter,
      );
      deps.registry.registerFallback("slack", adapter);
    }

    // Re-fetch so the response carries the persisted timestamps.
    const [fresh] = await db
      .select()
      .from(chatWorkspaces)
      .where(and(eq(chatWorkspaces.tenant_id, principal.tenant_id), eq(chatWorkspaces.id, row.id)))
      .limit(1);
    return c.json(rowToOutput(fresh ?? row), 201);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rows = await db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.tenant_id, principal.tenant_id));
    return c.json({ items: rows.map(rowToOutput) }, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const [row] = await db
      .select()
      .from(chatWorkspaces)
      .where(and(eq(chatWorkspaces.tenant_id, principal.tenant_id), eq(chatWorkspaces.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError("chat_workspace");

    await db
      .delete(chatWorkspaces)
      .where(and(eq(chatWorkspaces.tenant_id, principal.tenant_id), eq(chatWorkspaces.id, id)));

    deps.registry.unregister({
      tenant_id: row.tenant_id,
      platform: row.platform as "slack" | "teams" | "google_chat",
      workspace_id: row.workspace_id,
    });

    audit(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.CHAT_WORKSPACE_REMOVED,
        resource_type: "chat_workspace",
        resource_id: row.id,
        result: "success",
        metadata: { platform: row.platform, workspace_id: row.workspace_id },
      },
      db,
    );

    return c.json({ deleted: true as const }, 200);
  });
}
