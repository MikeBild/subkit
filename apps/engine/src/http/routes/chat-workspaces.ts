import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import {
  assertChatWorkspaceOwnershipAvailable,
  buildGoogleChatAdapterFromConfig,
  type ChatAdapterRegistry,
  ChatPlatformZodEnum,
  ChatWorkspaceInstallRefusedError,
  type ChatWorkspaceRow,
  findChatWorkspace,
  installChatWorkspace,
  listChatWorkspaces,
  removeChatWorkspace,
  SlackAdapter,
} from "../../chat/index.ts";
import { getConfig } from "../../config/loader.ts";
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

function mapInstallRefusal(err: unknown): never {
  if (err instanceof ChatWorkspaceInstallRefusedError) {
    if (err.refusal === "platform_unsupported") throw new BadRequestError(err.message);
    if (err.refusal === "installer_not_owned") throw new ForbiddenError(err.message);
    throw new ConflictError(err.message);
  }
  throw err;
}

function rowToOutput(row: ChatWorkspaceRow): z.infer<typeof ChatWorkspaceSchema> {
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

interface ChatWorkspaceRoutesDeps {
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
    await assertChatWorkspaceOwnershipAvailable(db, principal.tenant_id);
    const body = c.req.valid("json");

    if (body.platform === "slack") {
      const signingSecret = getConfig().platform.slack.signing_secret ?? "";
      if (!signingSecret) {
        throw new ServiceUnavailableError(
          "engine config platform.slack.signing_secret is empty — set it before installing a Slack workspace",
        );
      }
    }

    const row = await installChatWorkspace(db, { principal, body }).catch(mapInstallRefusal);
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

    const fresh = await findChatWorkspace(db, principal.tenant_id, row.id);
    return c.json(rowToOutput(fresh ?? row), 201);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rows = await listChatWorkspaces(db, principal.tenant_id);
    return c.json({ items: rows.map(rowToOutput) }, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await removeChatWorkspace(db, principal, id);
    if (!row) throw new NotFoundError("chat_workspace");

    deps.registry.unregister({
      tenant_id: row.tenant_id,
      platform: row.platform as "slack" | "teams" | "google_chat",
      workspace_id: row.workspace_id,
    });

    return c.json({ deleted: true as const }, 200);
  });
}
