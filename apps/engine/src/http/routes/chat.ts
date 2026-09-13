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

import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../../audit/index.ts";
import {
  type ChatAdapter,
  type ChatAdapterRegistry,
  type ChatEvent,
  type ChatPlatform,
  type ChatSyncResult,
  ensureChatRegistryHydrated,
  runChatTurnSync,
} from "../../chat/index.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { trafficClassFromHeader } from "../../stats/usage-events.ts";
import type { AppEnv } from "../openapi.ts";

export interface ChatRoutesDeps {
  registry: ChatAdapterRegistry;
  enqueue?: (job: { event: ChatEvent }) => Promise<void>;
  /** System tenant id used to audit denies when we can't resolve the
   * real tenant. Optional; falls back to a synthetic id. */
  systemTenantId?: string;
  /** Seam for the synchronous Google-Chat turn. Defaults to the real
   *  `runChatTurnSync`; tests inject a fake to drive each delivery arm
   *  without a live DB or LLM turn. */
  runSyncTurn?: (args: {
    db: Db;
    adapter: ChatAdapter;
    event: ChatEvent;
    timeoutMs: number;
  }) => Promise<ChatSyncResult>;
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
  // 8KB peek cap. The legitimate handshake is ~100 bytes; capping
  // before JSON.parse protects against a pathologically large body
  // crashing the parse stage. Real chat events route past this peek
  // through the adapter's verify() which has its own bounds.
  const PEEK_CAP = 8192;
  if (platform === "slack" && peekBody.length <= PEEK_CAP) {
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
    // Durable audit (auditAwait): a bad signature is a security event
    // and AGENTS.md forbids bypassing the audit log. Fire-and-forget
    // `audit()` could otherwise drop the row on a process crash
    // between the 401 send and the audit insert. Matches the
    // `auditAwait` discipline the rest of the chat surface uses.
    await auditAwait(
      {
        tenant_id: deps.systemTenantId ?? SYSTEM_TENANT_ID,
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

  const received = await adapter.receive(verified);
  const trafficClass = trafficClassFromHeader(
    req.headers.get("x-subkit-traffic-class") ?? undefined,
  );
  const event =
    trafficClass === "organic" ? received : { ...received, traffic_class: trafficClass };

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
        // Google dialog submits need BOTH: a sync close-ack (dismisses
        // the dialog inside the 30s window) AND the async queue hop for
        // the actual LLM resolution. Slack's paths leave `enqueue`
        // unset — behavior unchanged.
        if (sync.enqueue && deps.enqueue) {
          await deps.enqueue({ event });
        }
        return new Response(JSON.stringify(sync.response ?? { ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    } catch (err) {
      // The click is past the `trigger_id` window by the time the
      // queue dequeues, so the modal will never open and the user
      // sees nothing — and the queued `open_elicit:*` is deliberately
      // dropped by `routeChatInteraction`. Without an audit row the
      // failure is invisible to the tenant. Emit a denied row so
      // SIEM sees it; the structured log captures the throw details.
      logger.warn({
        module: "chat",
        action: "ingest.sync_interaction_failed",
        msg: "handleSyncInteraction threw; falling through to enqueue",
        platform,
        error: err instanceof Error ? err.message : String(err),
      });
      if (db) {
        try {
          await auditAwait(
            {
              tenant_id: deps.systemTenantId ?? SYSTEM_TENANT_ID,
              actor_type: "system",
              actor_id: null,
              action: AuditAction.CHAT_MESSAGE_DENIED,
              resource_type: "chat_message",
              resource_id: null,
              result: "denied",
              reason: "sync_interaction_failed",
              metadata: {
                platform,
                workspace_id_native: event.workspace_id,
                kind: event.kind,
                error: err instanceof Error ? err.message : String(err),
              },
            },
            db,
          );
        } catch {
          // audit write itself failed — log already captured the trigger
        }
      }
    }
  }

  // Google Chat requires a valid Chat Message in the SYNCHRONOUS HTTP
  // response, or it renders "[app] is not responding". For a MESSAGE that
  // runs a turn, run it inline (bounded) and return the rendered reply as
  // the body when it finishes fast; otherwise fall through to the async
  // queue exactly as today. `runChatTurnSync` claims the same dedup row
  // the queue worker uses, so a fast/detached inline turn and the queue
  // never both deliver (see chat/sync-turn.ts for the no-double-send proof).
  //
  // The `adapter` here is the verifier adapter (`findVerifier`), which for
  // Google is the single app-level adapter (one per engine) — the correct
  // send adapter. This branch is Google-only, so Slack's workspace-keyed
  // bot-token concern does not apply.
  if (
    platform === "google_chat" &&
    (event.kind === "mention" || event.kind === "slash_command") &&
    db
  ) {
    const runSync = deps.runSyncTurn ?? runChatTurnSync;
    const timeoutMs = getConfig().platform.googlechat.sync_turn_timeout_ms;
    const sync = await runSync({ db, adapter, event, timeoutMs });
    if (sync.deliver === "sync") {
      return new Response(JSON.stringify({ text: sync.text }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (sync.deliver === "acked") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // deliver === "defer" → fall through to the existing enqueue + {ok:true}.
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
      let adapter = deps.registry.findVerifier(platform);
      if (!adapter) {
        // Boot-race / cold-registry miss: lazily rehydrate (idempotent,
        // cooldown-guarded) and retry once before returning 503.
        await ensureChatRegistryHydrated(c.get("db"), deps.registry);
        adapter = deps.registry.findVerifier(platform);
      }
      return ingest(platform, adapter, c.req.raw, deps, c.get("db"));
    };

  app.post("/v1/chat/slack/events", handler("slack"));
  app.post("/v1/chat/slack/interactions", handler("slack"));
  app.post("/v1/chat/slack/slash", handler("slack"));
  app.post("/v1/chat/teams/messages", handler("teams"));
  app.post("/v1/chat/google/events", handler("google_chat"));
}
