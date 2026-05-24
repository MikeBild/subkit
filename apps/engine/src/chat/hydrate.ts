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

import { getConfig } from "../config/loader.ts";
import { decryptSecret } from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import { chatWorkspaces } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import type { ChatAdapterRegistry } from "./registry.ts";
import { SlackAdapter } from "./slack/adapter.ts";
import type { ChatPlatform } from "./types.ts";

/** AAD shape — mirrors `webhooks/inbound/service.ts aadFor`. */
function aadFor(tenant_id: string, workspace_row_id: string): string {
  return `chat-workspace:${tenant_id}:${workspace_row_id}`;
}

export interface HydrateOutcome {
  total: number;
  slack: number;
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

  // tenant-filter:exempt — every tenant's chat_workspaces is hydrated
  // into one process-local registry at boot; the row already carries
  // `tenant_id` for downstream scoping.
  const rows = await db.select().from(chatWorkspaces);

  const outcome: HydrateOutcome = {
    total: rows.length,
    slack: 0,
    skipped: 0,
    fallback_registered_for: [],
  };

  let slackFallbackPicked = false;

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
          outcome.skipped += 1;
          continue;
        }
        const botToken = decryptSecret(
          {
            ciphertext: row.bot_ciphertext,
            iv: row.bot_iv,
            auth_tag: row.bot_auth_tag,
          },
          aadFor(row.tenant_id, row.id),
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

      // Teams + Google Chat adapters exist as files but are not
      // activated by this implementation (see plan: separate later
      // work). They are skipped silently here; their adapter classes
      // satisfy the ChatAdapter interface (Step 7c reconciliation)
      // and can be hydrated by extending this function when their
      // own activation phase ships.
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
      outcome.skipped += 1;
    }
  }

  logger.info({
    module: "chat",
    action: "hydrate.completed",
    msg: "chat adapter registry hydrated",
    total: outcome.total,
    slack: outcome.slack,
    skipped: outcome.skipped,
    fallback_registered_for: outcome.fallback_registered_for,
  });

  return outcome;
}
