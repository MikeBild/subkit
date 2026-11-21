import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { getConfig } from "../config/loader.ts";
import { decryptSecret } from "../crypto/index.ts";
import type { Db } from "../db/client.ts";
import { chatWorkspaces } from "../db/schema/index.ts";
import { logger } from "../logging/index.ts";
import { chatWorkspaceAad } from "./api.ts";
import { GoogleChatAdapter } from "./google/adapter.ts";
import type { ChatAdapterRegistry } from "./registry.ts";
import { SlackAdapter } from "./slack/adapter.ts";
import type { ChatPlatform } from "./types.ts";

const GOOGLE_CHAT_BASE_URL = "https://chat.googleapis.com";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_CHAT_ISSUER = "chat@system.gserviceaccount.com";
const GOOGLE_CHAT_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";

export function buildGoogleChatAdapterFromConfig(google: {
  client_email: string;
  private_key: string;
  audience: string;
}): GoogleChatAdapter {
  return new GoogleChatAdapter({
    baseUrl: GOOGLE_CHAT_BASE_URL,
    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
    clientEmail: google.client_email,
    privateKeyPem: google.private_key,
    jwksUrl: GOOGLE_CHAT_JWKS_URL,
    issuer: GOOGLE_CHAT_ISSUER,
    audience: google.audience,
  });
}

export interface HydrateOutcome {
  total: number;
  slack: number;
  google_chat: number;
  skipped: number;
  fallback_registered_for: ChatPlatform[];
}

export async function hydrateChatRegistry(
  db: Db,
  registry: ChatAdapterRegistry,
): Promise<HydrateOutcome> {
  const cfg = getConfig();
  const slackSigningSecret = cfg.platform.slack.signing_secret ?? "";
  const google = cfg.platform.googlechat;
  const googleCredsComplete = Boolean(google.client_email && google.private_key && google.audience);

  // tenant-filter:exempt — every tenant's chat_workspaces is hydrated
  // into one process-local registry at boot; the row already carries
  // `tenant_id` for downstream scoping.
  const rows = await db.select().from(chatWorkspaces);

  const outcome: HydrateOutcome = {
    total: rows.length,
    slack: 0,
    google_chat: 0,
    skipped: 0,
    fallback_registered_for: [],
  };

  let slackFallbackPicked = false;
  let googleFallbackPicked = false;
  let googleAdapter: GoogleChatAdapter | null = null;

  for (const row of rows) {
    try {
      if (row.platform === "slack") {
        if (!slackSigningSecret) {
          logger.warn({
            module: "chat",
            action: "hydrate.skipped",
            msg: "slack workspace skipped — engine config platform.slack.signing_secret is empty",
            tenant_id: row.tenant_id,
            workspace_row_id: row.id,
            workspace_id_native: row.workspace_id,
          });
          await auditAwait(
            {
              tenant_id: row.tenant_id,
              actor_type: "system",
              actor_id: null,
              action: AuditAction.CHAT_WORKSPACE_HYDRATE_SKIPPED,
              resource_type: "chat_workspace",
              resource_id: row.id,
              result: "success",
              reason: "signing_secret_unset",
              metadata: {
                platform: row.platform,
                workspace_id: row.workspace_id,
              },
            },
            db,
          );
          outcome.skipped += 1;
          continue;
        }
        const botToken = decryptSecret(
          {
            ciphertext: row.bot_ciphertext,
            iv: row.bot_iv,
            auth_tag: row.bot_auth_tag,
          },
          chatWorkspaceAad(row.tenant_id, row.id),
        );
        const adapter = new SlackAdapter({
          signingSecret: slackSigningSecret,
          botToken,
        });
        registry.register(
          {
            tenant_id: row.tenant_id,
            platform: "slack",
            workspace_id: row.workspace_id,
          },
          adapter,
        );
        if (!slackFallbackPicked) {
          registry.registerFallback("slack", adapter);
          outcome.fallback_registered_for.push("slack");
          slackFallbackPicked = true;
        }
        outcome.slack += 1;
        continue;
      }

      if (row.platform === "google_chat") {
        if (!googleCredsComplete) {
          logger.warn({
            module: "chat",
            action: "hydrate.skipped",
            msg: "google chat workspace skipped — platform.googlechat.{client_email,private_key,audience} incomplete",
            tenant_id: row.tenant_id,
            workspace_row_id: row.id,
            workspace_id_native: row.workspace_id,
          });
          await auditAwait(
            {
              tenant_id: row.tenant_id,
              actor_type: "system",
              actor_id: null,
              action: AuditAction.CHAT_WORKSPACE_HYDRATE_SKIPPED,
              resource_type: "chat_workspace",
              resource_id: row.id,
              result: "success",
              reason: "google_credentials_unset",
              metadata: {
                platform: row.platform,
                workspace_id: row.workspace_id,
              },
            },
            db,
          );
          outcome.skipped += 1;
          continue;
        }
        googleAdapter ??= buildGoogleChatAdapterFromConfig(google);
        registry.register(
          {
            tenant_id: row.tenant_id,
            platform: "google_chat",
            workspace_id: row.workspace_id,
          },
          googleAdapter,
        );
        if (!googleFallbackPicked) {
          registry.registerFallback("google_chat", googleAdapter);
          outcome.fallback_registered_for.push("google_chat");
          googleFallbackPicked = true;
        }
        outcome.google_chat += 1;
        continue;
      }

      outcome.skipped += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({
        module: "chat",
        action: "hydrate.failed",
        msg: "chat workspace failed to hydrate — skipping",
        tenant_id: row.tenant_id,
        workspace_row_id: row.id,
        platform: row.platform,
        error: message,
      });
      await auditAwait(
        {
          tenant_id: row.tenant_id,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.CHAT_WORKSPACE_HYDRATE_SKIPPED,
          resource_type: "chat_workspace",
          resource_id: row.id,
          result: "success",
          reason: "hydrate_failed",
          metadata: {
            platform: row.platform,
            workspace_id_native: row.workspace_id,
            error: message,
          },
        },
        db,
      );
      outcome.skipped += 1;
    }
  }

  logger.info({
    module: "chat",
    action: "hydrate.completed",
    msg: "chat adapter registry hydrated",
    total: outcome.total,
    slack: outcome.slack,
    google_chat: outcome.google_chat,
    skipped: outcome.skipped,
    fallback_registered_for: outcome.fallback_registered_for,
  });

  return outcome;
}

const REHYDRATE_COOLDOWN_MS = 30_000;
let lastRehydrateAt = 0;
let rehydrateInFlight: Promise<void> | null = null;

export async function ensureChatRegistryHydrated(
  db: Db,
  registry: ChatAdapterRegistry,
): Promise<void> {
  if (rehydrateInFlight) return rehydrateInFlight;
  if (Date.now() - lastRehydrateAt < REHYDRATE_COOLDOWN_MS) return;
  rehydrateInFlight = (async () => {
    try {
      await hydrateChatRegistry(db, registry);
    } catch (err) {
      logger.warn({
        module: "chat",
        action: "rehydrate.failed",
        msg: "lazy chat-registry rehydrate failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      lastRehydrateAt = Date.now();
      rehydrateInFlight = null;
    }
  })();
  return rehydrateInFlight;
}

export function _resetChatRehydrateStateForTests(): void {
  lastRehydrateAt = 0;
  rehydrateInFlight = null;
}
