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
    platform: ChatPlatformZodEnum,
    /** Platform-native workspace id. Slack: `team_id` (T…); Google
     *  Chat: the space resource name (`spaces/…`) — one install row per
     *  space, since Google events carry no domain/customer id. */
    workspace_id: z.string().min(1),
    /** Bot User OAuth Token for Slack (`xoxb-…`) — required there
     *  because the token is per-workspace. Google Chat authenticates
     *  outbound with the APP-LEVEL service account from engine config
     *  (`platform.googlechat.*`), so the field is omitted. Teams keeps
     *  accepting a credential string for forward-compat. */
    bot_token: z.string().min(1).optional(),
    /** The installing operator's platform user id (Slack `U…`, Google
     *  `users/…`). Linked to the authenticated subkit user via
     *  `chat_identities` so the operator's first chat message resolves
     *  to a real principal instead of being rejected as "not linked". */
    installer_platform_user_id: z.string().min(1),
    /** Optional default channel (e.g. for notifications dispatch). */
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
    // pgEnum already constrains the column to the three values; the
    // narrowing cast is the documented contract, not a `any`.
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
        // 503 (not 400): an empty signing_secret is an engine-config
        // gap, not a caller-side validation error. The body is fine —
        // the engine just can't service the install until the
        // operator sets the config key.
        throw new ServiceUnavailableError(
          "engine config platform.slack.signing_secret is empty — set it before installing a Slack workspace",
        );
      }
    }

    // Cross-tenant claim check: a real Slack `team_id` is globally
    // unique (it belongs to exactly one Slack workspace), so two
    // tenants installing the same one is always wrong. The DB
    // enforces this via a unique index on (platform, workspace_id);
    // catching it here lets us emit a meaningful 409 + denied audit
    // row instead of bubbling a generic DB constraint violation.
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
      // Audit the deny on the outer `db` (no tx to roll back into);
      // do NOT include the foreign tenant_id in metadata — would leak
      // across the isolation boundary.
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: "user",
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

    // Teams has no hydrated adapter (chat/hydrate.ts) and no
    // conversation-reference persistence, so an install row would be
    // dead — non-routing, yet holding the global (platform, workspace_id)
    // slot against a real future install. Reject rather than squat.
    if (body.platform === "teams") {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: "user",
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

    // Tenant-capture guard for GLOBAL-id platforms (google_chat). Their
    // native user id names one human across every space, and
    // dm-autoregister.ts matches a DM sender on (platform,
    // platform_user_id) IGNORING workspace — so seeding the identity link
    // from an unproven `installer_platform_user_id` would let a caller
    // bind a VICTIM's People-id to their own subkit user and hijack the
    // victim's future DMs into this tenant. Require proof the CALLER owns
    // the id: an EXISTING verified `chat_identity` in their tenant. That
    // identity is bootstrapped by the JWT-verified DM auto-register path
    // (dm-autoregister.ts) — DM the app once, then install named spaces.
    // A raw SYSTEM deny row is NOT accepted as proof: its sender is
    // whoever messaged the space, not necessarily the caller.
    // Workspace-scoped platforms (slack) are exempt — their ids can't
    // bridge tenants and never trigger dm-autoregister.
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
            actor_type: "user",
            actor_id: principal.id,
            action: AuditAction.CHAT_WORKSPACE_INSTALLED,
            resource_type: "chat_workspace",
            resource_id: null,
            result: "denied",
            reason: "installer_not_owned",
            metadata: {
              platform: body.platform,
              workspace_id: body.workspace_id,
              // The claimed id is the caller's own input; recording it
              // aids forensics and does not leak another tenant's data.
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

    // Insert with a placeholder ciphertext, then re-encrypt with the
    // row-bound AAD now that we have the row id. Mirrors the webhooks/
    // inbound install flow which faces the same "AAD needs the row id"
    // dance.
    //
    // Wrapped in `db.transaction((tx) => …)` so the
    // INSERT(placeholder) → UPDATE(bound ciphertext) → INSERT(identity
    // link) sequence commits atomically. Without the transaction, a
    // crash between the placeholder insert and the bound update would
    // leave a stranded chat_workspaces row whose ciphertext is
    // undecryptable (placeholder AAD); the next install retry would
    // hit the unique conflict on (tenant_id, platform, workspace_id)
    // and 409, stranding the operator until a manual DELETE.
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
        // The route returns 409 — abort the transaction by throwing; the
        // catch outside re-throws as a typed ConflictError so the HTTP
        // layer formats it correctly.
        throw new ConflictError(
          `${body.platform} workspace ${body.workspace_id} is already installed in this tenant`,
        );
      }

      // Re-encrypt with the row-bound AAD, then update. A google_chat
      // install has no per-workspace token (app-level service account
      // from config) — store a bound sentinel so the NOT-NULL cipher
      // columns stay decryptable under the row AAD; nothing ever reads
      // it back for that platform (hydrate builds the adapter from
      // config).
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

      // Link the installer's platform user → the authenticated subkit
      // user so the operator's first chat message resolves to a real
      // principal. Capture `.returning()` so we can distinguish three
      // outcomes:
      //   - new row → emit CHAT_IDENTITY_LINKED kind:install
      //   - already linked to THIS user_id → emit a noop audit
      //   - already linked to a DIFFERENT user_id → emit a deny audit
      //     and surface a clear 409 so the operator knows the install
      //     succeeded but their account isn't bound (without this they
      //     would hit "your chat account isn't linked" on first message
      //     with no clue why).
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
        // Look up the existing row so we can tell which case we're in.
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
          // The Slack user is bound to a different subkit user already.
          // Rolling back the install is the right call: the operator
          // explicitly asked for THIS subkit user to be linked, and
          // shipping a workspace whose installer doesn't actually have
          // a working identity is a silent-failure trap. Throw inside
          // the tx → workspace insert + bot-token update both roll
          // back, leaving a clean state to retry from.
          //
          // Write the deny audit on the OUTER `db` (not `tx`) so it
          // survives the rollback — SIEM/forensics need the record of
          // a tenant admin attempting to bind a Slack identity that's
          // already claimed by another principal.
          // NOTE: do NOT include `existing.user_id` in the metadata.
          // The conflicting row may belong to another tenant — the
          // UUID would leak across the isolation boundary into the
          // current tenant's audit log. Forensic correlation works
          // off the (platform, workspace_id, platform_user_id)
          // tuple, which is sufficient + leak-free.
          await auditAwait(
            {
              tenant_id: principal.tenant_id,
              actor_type: "user",
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

      // Both audits commit INSIDE the transaction — `auditAwait(..., tx)`
      // ensures the install + the audit trail rise or fall together.
      // Fire-and-forget `audit()` on a successful tx could otherwise
      // strand a committed install with no audit row if the process
      // dies between commit and the audit insert (AGENTS.md: "Never
      // bypass the audit log").
      await auditAwait(
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
        tx,
      );
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: "user",
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

    // Register the adapter live so the next inbound event finds it
    // without waiting for a reboot. Slack + Google Chat are hydrated
    // today; the Teams branch stays silent on purpose (its activation
    // is separate later work). A google_chat install with incomplete
    // engine-config credentials registers nothing — the boot-time
    // hydrate emits the CHAT_WORKSPACE_HYDRATE_SKIPPED audit for that
    // state, and the lazy rehydrate picks the row up once config is
    // fixed.
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

    // Wrap the DELETE + audit in a tx so the route can't return 200
    // for a removal that never produced an audit row (a process crash
    // between the two would otherwise leave a removed workspace with
    // no forensic record).
    await db.transaction(async (tx) => {
      await tx
        .delete(chatWorkspaces)
        .where(and(eq(chatWorkspaces.tenant_id, principal.tenant_id), eq(chatWorkspaces.id, id)));
      await auditAwait(
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
        tx,
      );
    });

    // Registry eviction happens AFTER the durable transaction so the
    // in-memory adapter outlives the DB removal only on a registry
    // exception (acceptable — next boot's hydration will be authoritative).
    deps.registry.unregister({
      tenant_id: row.tenant_id,
      platform: row.platform as "slack" | "teams" | "google_chat",
      workspace_id: row.workspace_id,
    });

    return c.json({ deleted: true as const }, 200);
  });
}
