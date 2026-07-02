// Boot-time chat-adapter registry hydration.
//
// Without this, `ChatAdapterRegistry.findVerifier("slack")` returns null
// at startup and every Slack POST gets 503 adapter_not_registered. The
// chat-route ingestion path therefore reads from a registry hydrated
// here, just before the HTTP listener accepts traffic.
//
// Credential model (decided): one subkit Slack app.
//   - signing secret: app-level. ONE value, shared across every installed
//     workspace. Stored in engine config (`platform.slack.signing_secret`)
//     marked `secret: true`. Read once at boot.
//   - bot token: workspace-level. One per `chat_workspaces` row, AES-256-GCM
//     encrypted with row-bound AAD (`chat-workspace:<tenant>:<id>`),
//     mirrors the AAD pattern used by `webhooks/inbound/service.ts`.
//
// Resolution at runtime:
//   - Verify: the route calls `registry.findVerifier("slack")` BEFORE the
//     workspace is known. Any registered Slack adapter works (they all
//     hold the same signing secret), so we also `registerFallback("slack",
//     adapter)` with the first one we build.
//   - Outbound: the chat.event worker resolves the workspace-specific
//     adapter by `(tenant, platform, workspace_id)` so the right bot
//     token is used.

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { getConfig } from "../config/loader.ts";
import { decryptSecret } from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import { chatWorkspaces } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { chatWorkspaceAad } from "./api.ts";
import { GoogleChatAdapter } from "./google/adapter.ts";
import type { ChatAdapterRegistry } from "./registry.ts";
import { SlackAdapter } from "./slack/adapter.ts";
import type { ChatPlatform } from "./types.ts";

// Production constants for the Google Chat platform. The inbound JWKS
// belongs to Google's Chat system service account (the app-level
// "Project Number" audience mode — the only mode the adapter speaks);
// pinning them here means a hydrated adapter can never come up with
// verification disabled (the adapter treats a missing jwksUrl as
// "trusted transport", which is only acceptable in tests).
const GOOGLE_CHAT_BASE_URL = "https://chat.googleapis.com";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_CHAT_ISSUER = "chat@system.gserviceaccount.com";
const GOOGLE_CHAT_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";

/**
 * Build the app-level Google Chat adapter from engine config with the
 * pinned production constants. Shared by boot hydration and the
 * workspace-install route so a live install and a reboot can never
 * produce differently-configured adapters.
 */
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

/**
 * Build adapters from every `chat_workspaces` row and register them.
 * Idempotent at the registry level (`register` overwrites). Safe to call
 * after a runtime install (the workspace-install route does its own
 * `register` for the freshly-installed row, then this can be re-run on
 * the next boot).
 */
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
  // ONE adapter serves every Google workspace row: credentials are
  // app-level (service account + audience), unlike Slack's
  // per-workspace bot token. Built lazily so a deployment without
  // Google Chat never constructs it.
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
          // Per-tenant audit row so a re-deployment with a wiped
          // signing secret is visible in each tenant's SIEM, not just
          // in the engine's structured log stream. A silent hydration
          // skip would otherwise disable every Slack workspace
          // unnoticed.
          // Dedicated action — not CHAT_WORKSPACE_INSTALLED — so an
          // auditor filtering "installs in tenant X" doesn't see a
          // phantom denied install on every boot.
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
          // All Slack workspaces share the one app-level signing secret,
          // so any adapter verifies any incoming Slack request. Verify
          // runs before we know which workspace sent the event, hence
          // the fallback.
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
          // Same SIEM-visibility contract as the Slack signing-secret
          // guard: a redeploy that wiped the service-account creds
          // would otherwise silently disable every Google space. This
          // guard is also what closes the adapter's fail-open verify
          // path in production — a registered adapter ALWAYS carries
          // the pinned jwksUrl below.
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
          // Verify runs before the workspace is known (same shape as
          // Slack) — and all Google rows share the one app-level
          // adapter anyway.
          registry.registerFallback("google_chat", googleAdapter);
          outcome.fallback_registered_for.push("google_chat");
          googleFallbackPicked = true;
        }
        outcome.google_chat += 1;
        continue;
      }

      // The Teams adapter class satisfies the ChatAdapter interface but
      // is not hydrated yet: its outbound credentials (Bot Framework
      // client_credentials) and the per-activity serviceUrl handling
      // aren't wired through chat_workspaces. Skipping silently keeps
      // the registry free of half-installed adapters; activating Teams
      // means extending this function with its credential shape.
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
      // Per-tenant audit row so a silent decryption failure — typical
      // cause: MASTER_KEY rotated without re-encrypting bot tokens —
      // surfaces in the tenant's SIEM, not just the engine's structured
      // log. Mirrors the signing-secret-unset audit above; same action
      // (CHAT_WORKSPACE_HYDRATE_SKIPPED) keeps the dashboard query
      // surface flat ("show me workspaces that didn't come up this
      // boot") and uses `reason` to discriminate causes.
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

// Lazy rehydrate-on-miss. The registry is process-local and hydrated once
// at boot; a request that arrives during the boot-race window (or, in a
// future multi-instance deploy, against an instance that missed an install)
// would otherwise 503 forever. On a miss the caller invokes this, which
// re-runs the idempotent hydrate at most once per cooldown (single-flight),
// then retries the lookup. Never removes a live adapter; a genuinely-0-
// install tenant can't DB-storm (cooldown).
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

/** Test-only: reset the rehydrate cooldown/single-flight state. */
export function _resetChatRehydrateStateForTests(): void {
  lastRehydrateAt = 0;
  rehydrateInFlight = null;
}
