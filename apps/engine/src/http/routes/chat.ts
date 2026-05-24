// HTTP ingestion surface for chat platforms.
//
//   POST /v1/chat/slack/events        — Slack Events API (app_mention,
//                                       url_verification)
//   POST /v1/chat/slack/interactions  — Slack Block Kit interactions
//   POST /v1/chat/slash               — Slack slash commands
//                                       (exposed as /v1/chat/slack/slash
//                                       for consistency)
//   POST /v1/chat/teams/messages      — Teams Bot Framework activities
//   POST /v1/chat/google/events       — Google Chat events
//
// Each route:
//   1. Picks the right adapter from the registry.
//   2. Calls adapter.verify() — bad signature → 401 +
//      chat.message.denied audit.
//   3. Handles the Slack URL verification handshake (echoes challenge).
//   4. Normalizes via adapter.receive() and enqueues a `chat.event`
//      pg-boss job so the dispatcher can run out-of-band. (Platforms
//      expect fast responses.)
//
// Routes are plain Hono handlers — they sit outside the OpenAPI
// catalog because the public payloads are platform-owned.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { AuditAction, audit } from "../../audit/index.ts";
import type {
  ChatAdapter,
  ChatAdapterRegistry,
  ChatEvent,
  ChatPlatform,
} from "../../chat/index.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import type { AppEnv } from "../openapi.ts";

export interface ChatRoutesDeps {
  registry: ChatAdapterRegistry;
  enqueue?: (job: { event: ChatEvent }) => Promise<void>;
  /** System tenant id used to audit denies when we can't resolve the
   * real tenant. Optional; falls back to a synthetic id. */
  systemTenantId?: string;
}

async function ingest(
  platform: ChatPlatform,
  adapter: ChatAdapter | null,
  req: Request,
  deps: ChatRoutesDeps,
  db?: Db,
): Promise<Response> {
  // The Slack url_verification handshake is the FIRST thing Slack does
  // when an Events API subscription URL is configured — and it MUST
  // succeed BEFORE any workspace is installed (Slack won't let the
  // operator complete app setup without a verified URL, and the
  // operator can't install a workspace until app setup completes —
  // chicken-and-egg). Short-circuit here, before the
  // adapter-not-registered check, so a fresh engine answers the
  // challenge without requiring a prior install. The handshake is a
  // fixed protocol (echo the challenge string back) and carries no
  // payload an attacker could exploit.
  const cloned = req.clone();
  const peekBody = await cloned.text();
  if (platform === "slack") {
    try {
      const maybe = JSON.parse(peekBody);
      if (maybe && maybe.type === "url_verification" && typeof maybe.challenge === "string") {
        return new Response(JSON.stringify({ challenge: maybe.challenge }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    } catch {
      // not JSON — slash commands etc.
    }
  }

  if (!adapter) {
    return new Response(JSON.stringify({ error: "adapter_not_registered" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const verified = await adapter.verify(req);
  if (!verified) {
    audit(
      {
        tenant_id: deps.systemTenantId ?? "00000000-0000-0000-0000-000000000000",
        actor_type: "system",
        action: AuditAction.CHAT_MESSAGE_DENIED,
        resource_type: "chat_message",
        result: "denied",
        metadata: { platform },
      },
      db,
    );
    return new Response(JSON.stringify({ error: "bad_signature" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const event = await adapter.receive(verified);

  // Synchronous platform-specific fast path. Slack uses this to call
  // `views.open` on an "Antworten" button click within the ~3 s
  // `trigger_id` window — the modal would never open if this hop went
  // through the chat.event queue. Adapters that don't need a fast
  // path (Teams Adaptive Cards are inline; Google dialogs open from
  // card actions in-band) omit `handleSyncInteraction`.
  if (typeof adapter.handleSyncInteraction === "function" && db) {
    try {
      const sync = await adapter.handleSyncInteraction({ event, db });
      if (sync.handled) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    } catch (err) {
      // Fall through to normal enqueue path — the click is at worst
      // lost (modal won't open), but we still acknowledge to keep
      // Slack happy. The adapter normally logs the underlying failure,
      // but a sync throw above the adapter's own logger.warn (e.g. a
      // TypeError on malformed event.raw) would otherwise bypass that;
      // a bare `catch {}` is fragile observability so surface it here.
      logger.warn({
        module: "chat",
        action: "ingest.sync_interaction_failed",
        msg: "handleSyncInteraction threw; falling through to enqueue",
        platform,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (deps.enqueue) {
    await deps.enqueue({ event });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function registerChatRoutes(app: OpenAPIHono<AppEnv>, deps: ChatRoutesDeps): void {
  const handler =
    (platform: ChatPlatform) => async (c: { req: { raw: Request }; get: (k: "db") => Db }) => {
      const adapter = deps.registry.findVerifier(platform);
      return ingest(platform, adapter, c.req.raw, deps, c.get("db"));
    };

  app.post("/v1/chat/slack/events", handler("slack"));
  app.post("/v1/chat/slack/interactions", handler("slack"));
  app.post("/v1/chat/slack/slash", handler("slack"));
  app.post("/v1/chat/teams/messages", handler("teams"));
  app.post("/v1/chat/google/events", handler("google_chat"));
}
