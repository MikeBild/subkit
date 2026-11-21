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
import { trafficClassFromHeader } from "../../stats/index.ts";
import type { AppEnv } from "../openapi.ts";

interface ChatRoutesDeps {
  registry: ChatAdapterRegistry;
  enqueue?: (job: { event: ChatEvent }) => Promise<void>;
  systemTenantId?: string;
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
  const cloned = req.clone();
  const peekBody = await cloned.text();
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
    } catch {}
  }

  if (!adapter) {
    return new Response(JSON.stringify({ error: "adapter_not_registered" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const verified = await adapter.verify(req);
  if (!verified) {
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

  if (typeof adapter.handleSyncInteraction === "function" && db) {
    try {
      const sync = await adapter.handleSyncInteraction({ event, db });
      if (sync.handled) {
        if (sync.enqueue && deps.enqueue) {
          await deps.enqueue({ event });
        }
        return new Response(JSON.stringify(sync.response ?? { ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    } catch (err) {
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
        } catch {}
      }
    }
  }

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
