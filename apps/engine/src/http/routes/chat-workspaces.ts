import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import {
  buildGoogleChatAdapterFromConfig,
  type ChatAdapterRegistry,
  ChatPlatformZodEnum,
  chatWorkspaceAad,
  PLATFORM_HAS_GLOBAL_USER_IDS,
  SlackAdapter,
} from "../../chat/index.ts";
import { getConfig } from "../../config/loader.ts";
import { encryptSecret } from "../../crypto/aes-gcm.ts";
import { chatIdentities, chatWorkspaces } from "../../db/schema/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ChatWorkspaceSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    platform: ChatPlatformZodEnum,
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
    platform: ChatPlatformZodEnum,
    workspace_id: z.string().min(1),
    bot_token: z.string().min(1).optional(),
    installer_platform_user_id: z.string().min(1),
    default_channel: z.string().nullable().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.platform !== "google_chat" && !body.bot_token) {
      ctx.addIssue({
        code: "custom",
        path: ["bot_token"],
        message: `bot_token is required for platform "${body.platform}" (per-workspace credential); only google_chat installs omit it`,
      });
    }
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
        throw new ServiceUnavailableError(
          "engine config platform.slack.signing_secret is empty — set it before installing a Slack workspace",
        );
      }
    }

    // tenant-filter:exempt — global uniqueness check spans tenants by
    // design; we never expose the foreign row, only the conflict.
    const [foreignRow] = await db
      .select({ tenant_id: chatWorkspaces.tenant_id })
      .from(chatWorkspaces)
      .where(
        and(
          eq(chatWorkspaces.platform, body.platform),
          eq(chatWorkspaces.workspace_id, body.workspace_id),
        ),
      )
      .limit(1);
    if (foreignRow && foreignRow.tenant_id !== principal.tenant_id) {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.CHAT_WORKSPACE_INSTALLED,
          resource_type: "chat_workspace",
          resource_id: null,
          result: "denied",
          reason: "workspace_already_claimed",
          metadata: {
            platform: body.platform,
            workspace_id: body.workspace_id,
          },
        },
        db,
      );
      throw new ConflictError(
        `${body.platform} workspace ${body.workspace_id} is already installed in another tenant`,
      );
    }

    if (body.platform === "teams") {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.CHAT_WORKSPACE_INSTALLED,
          resource_type: "chat_workspace",
          resource_id: null,
          result: "denied",
          reason: "platform_unsupported",
          metadata: { platform: body.platform, workspace_id: body.workspace_id },
        },
        db,
      );
      throw new BadRequestError(
        "teams chat spaces are not supported yet — no adapter is hydrated for the teams platform",
      );
    }

    if (PLATFORM_HAS_GLOBAL_USER_IDS[body.platform]) {
      const [owned] = await db
        .select({ id: chatIdentities.id })
        .from(chatIdentities)
        .where(
          and(
            eq(chatIdentities.tenant_id, principal.tenant_id),
            eq(chatIdentities.user_id, principal.id),
            eq(chatIdentities.platform, body.platform),
            eq(chatIdentities.platform_user_id, body.installer_platform_user_id),
          ),
        )
        .limit(1);
      if (!owned) {
        await auditAwait(
          {
            tenant_id: principal.tenant_id,
            actor_type: principal.kind,
            actor_id: principal.id,
            action: AuditAction.CHAT_WORKSPACE_INSTALLED,
            resource_type: "chat_workspace",
            resource_id: null,
            result: "denied",
            reason: "installer_not_owned",
            metadata: {
              platform: body.platform,
              workspace_id: body.workspace_id,
              installer_platform_user_id: body.installer_platform_user_id,
            },
          },
          db,
        );
        throw new ForbiddenError(
          "installer_platform_user_id is not a verified identity you own — " +
            "DM the app once so your account links, then retry the install",
        );
      }
    }

    const placeholder = encryptSecret("__placeholder__");
    let row: typeof chatWorkspaces.$inferSelect | undefined;
    let installerLinked = false;
    await db.transaction(async (tx) => {
      const insertResult = await tx
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
      row = insertResult[0];
      if (!row) {
        throw new ConflictError(
          `${body.platform} workspace ${body.workspace_id} is already installed in this tenant`,
        );
      }

      const bound = encryptSecret(
        body.bot_token ?? "__no_workspace_token__",
        chatWorkspaceAad(row.tenant_id, row.id),
      );
      await tx
        .update(chatWorkspaces)
        .set({
          bot_ciphertext: bound.ciphertext,
          bot_iv: bound.iv,
          bot_auth_tag: bound.auth_tag,
          updated_at: new Date(),
        })
        .where(eq(chatWorkspaces.id, row.id));

      const linkResult = await tx
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
        })
        .returning();
      if (linkResult[0]) {
        installerLinked = true;
      } else {
        // tenant-filter:exempt — the chat_identities row is keyed by
        // the platform identity tuple (platform, workspace_id,
        // platform_user_id) which is globally unique. A different-
        // tenant binding for the same Slack id is the exact conflict
        // this branch is designed to surface; adding a tenant_id
        // predicate here would hide it and silently overwrite the
        // operator's link state.
        const [existing] = await tx
          .select({ user_id: chatIdentities.user_id })
          .from(chatIdentities)
          .where(
            and(
              eq(chatIdentities.platform, body.platform),
              eq(chatIdentities.workspace_id, body.workspace_id),
              eq(chatIdentities.platform_user_id, body.installer_platform_user_id),
            ),
          )
          .limit(1);
        if (existing && existing.user_id !== principal.id) {
          await auditAwait(
            {
              tenant_id: principal.tenant_id,
              actor_type: principal.kind,
              actor_id: principal.id,
              action: AuditAction.CHAT_IDENTITY_LINKED,
              resource_type: "chat_identity",
              resource_id: principal.id,
              result: "denied",
              reason: "platform_user_already_linked_to_other_subkit_user",
              metadata: {
                kind: "install",
                platform: body.platform,
                platform_user_id: body.installer_platform_user_id,
                workspace_id: body.workspace_id,
              },
            },
            db,
          );
          throw new ConflictError(
            `slack user ${body.installer_platform_user_id} in workspace ` +
              `${body.workspace_id} is already linked to a different subkit user; ` +
              "unlink it via DELETE /v1/chat/identities/<id> and retry the install",
          );
        }
      }

      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
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
        tx,
      );
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.CHAT_IDENTITY_LINKED,
          resource_type: "chat_identity",
          resource_id: principal.id,
          result: "success",
          ...(installerLinked ? {} : { reason: "install_noop" }),
          metadata: {
            kind: installerLinked ? "install" : "install_noop",
            platform: body.platform,
            platform_user_id: body.installer_platform_user_id,
          },
        },
        tx,
      );
    });
    if (!row) throw new ConflictError("chat_workspace install transaction produced no row");

    if (body.platform === "slack" && body.bot_token) {
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
    } else if (body.platform === "google_chat") {
      const google = getConfig().platform.googlechat;
      if (google.client_email && google.private_key && google.audience) {
        const adapter = buildGoogleChatAdapterFromConfig(google);
        deps.registry.register(
          {
            tenant_id: row.tenant_id,
            platform: "google_chat",
            workspace_id: row.workspace_id,
          },
          adapter,
        );
        deps.registry.registerFallback("google_chat", adapter);
      }
    }

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

    await db.transaction(async (tx) => {
      await tx
        .delete(chatWorkspaces)
        .where(and(eq(chatWorkspaces.tenant_id, principal.tenant_id), eq(chatWorkspaces.id, id)));
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.CHAT_WORKSPACE_REMOVED,
          resource_type: "chat_workspace",
          resource_id: row.id,
          result: "success",
          metadata: { platform: row.platform, workspace_id: row.workspace_id },
        },
        tx,
      );
    });

    deps.registry.unregister({
      tenant_id: row.tenant_id,
      platform: row.platform as "slack" | "teams" | "google_chat",
      workspace_id: row.workspace_id,
    });

    return c.json({ deleted: true as const }, 200);
  });
}
