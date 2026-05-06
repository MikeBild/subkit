// Standalone Bun WebSocket server for the tunnel surface.
//
// Starts a `Bun.serve` listener that terminates the `/v1/tunnels/ws`
// upgrade, authenticates the agent via an api_key bearer token, materialises
// the tunnel rows on first `register` frame, and wires every registered
// target into the shared {@link TunnelRegistry}. The same listener serves
// any HTTP handler passed in via `fetch`, so a caller can point the engine
// at a single port for both REST + WS.

import { audit } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { createApiKeyProvider } from "../auth/providers/api-key.ts";
import type { Db } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { log, logger } from "../logging/logger.ts";
import {
  decodeFrame,
  encodeFrame,
  type TunnelRegisterFrame,
  type TunnelResponseFrame,
} from "./framing.ts";
import { type TunnelRegistry, tunnelRegistry } from "./registry.ts";
import {
  fingerprintAgentToken,
  markTunnelDisconnected,
  touchTunnelLastSeen,
  upsertTunnel,
} from "./service.ts";

type SocketState = {
  tenant_id: string;
  api_key_id?: string;
  tunnel_id?: string;
  tunnel_name?: string;
  targets: Set<string>;
  registered: boolean;
  token: string;
  remote_addr?: string;
};

export interface TunnelWsServerOptions {
  db: Db;
  port?: number;
  hostname?: string;
  registry?: TunnelRegistry;
  // Optional HTTP fetch handler — mounted for every non-WS URL.
  fetch?: (req: Request) => Response | Promise<Response>;
}

export interface TunnelWsServerHandle {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

// Narrow structural contract for the Bun server object we care about —
// `Bun` types live in `bun-types` which is a dev dependency.
type BunLikeServer = {
  port: number;
  hostname: string;
  stop: (closeActiveConnections?: boolean) => void;
  upgrade: (req: Request, opts?: { data?: unknown; headers?: HeadersInit }) => boolean;
};

function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  if (auth.length < 8 || auth.slice(0, 7).toLowerCase() !== "bearer ") return null;
  return auth.slice(7).trim();
}

export function startTunnelWsServer(opts: TunnelWsServerOptions): TunnelWsServerHandle {
  const db = opts.db;
  const registry = opts.registry ?? tunnelRegistry;
  const apiKeyProvider = createApiKeyProvider({ db });
  const fetchHandler = opts.fetch;

  // `Bun.serve` is provided at runtime when executed under bun. We avoid
  // a static dependency on `bun-types` here so plain `tsc` builds stay happy.
  const bun = (globalThis as unknown as { Bun?: { serve: (opts: unknown) => BunLikeServer } }).Bun;
  if (!bun) {
    throw new Error("startTunnelWsServer requires the Bun runtime");
  }

  // Workaround: In Bun compiled binaries, `new Response(...)` inside
  // `Bun.serve()` sometimes creates a "lightweight" Response that
  // Bun's internal handler rejects. `Response.json()` uses a different
  // code path that always produces a native-backed Response.
  const reject = (msg: string, status: number) => Response.json({ error: msg }, { status });

  const server = bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "0.0.0.0",
    async fetch(req: Request, srv: BunLikeServer) {
      try {
        const url = new URL(req.url);
        if (url.pathname === "/v1/tunnels/ws") {
          const token = extractBearer(req);
          if (!token) {
            return reject("missing bearer token", 401);
          }
          // Reuse the P2 api_key provider — identical semantics with the HTTP API.
          const principal = await apiKeyProvider.resolve(req);
          if (!principal) {
            return reject("unauthorized", 401);
          }
          if (principal.kind !== "system_account") {
            return reject("system account required", 403);
          }
          // Pass-2 C6/C7: gate on `tunnel:agent` via the RBAC
          // evaluator. Built-in `admin` short-circuits, built-in
          // `tunnel_agent` has the permission, and legacy scope flow
          // still works because the check falls through to the
          // evaluator's role lookup. We still accept a legacy
          // `tunnel_agent` scope for compatibility with older keys.
          const { can: rbacCan } = await import("../rbac/evaluator.ts");
          const decision = await rbacCan(db, {
            tenant_id: principal.tenant_id,
            principal,
            permission: "tunnel:agent",
          });
          const legacyScope = (principal.scopes ?? []).includes("tunnel_agent");
          if (!decision.allow && !legacyScope) {
            log.tunnel.auth({
              result: "denied",
              tenant_id: principal.tenant_id,
              reason: "tunnel:agent_permission_denied",
            });
            return reject("forbidden", 403);
          }
          log.tunnel.auth({
            result: "allowed",
            tenant_id: principal.tenant_id,
            principal_id: principal.id,
          });
          const state: SocketState = {
            tenant_id: principal.tenant_id,
            targets: new Set(),
            registered: false,
            token,
            ...(principal.api_key_id !== undefined ? { api_key_id: principal.api_key_id } : {}),
          };
          const upgraded = srv.upgrade(req, { data: state });
          if (upgraded) return undefined;
          return reject("upgrade failed", 400);
        }
        if (fetchHandler) {
          const response = await fetchHandler(req);
          if (!(response instanceof Response)) {
            return reject("handler returned invalid response", 500);
          }
          return response;
        }
        return reject("not found", 404);
      } catch (err) {
        logger.error({
          module: "tunnels",
          action: "ws.fetch.error",
          msg: "fetch handler threw",
          error: err instanceof Error ? err.message : String(err),
        });
        return reject("internal error", 500);
      }
    },
    websocket: {
      async open(ws: {
        data: SocketState;
        send: (data: string) => void;
        close: (code?: number, reason?: string) => void;
        readyState: number;
      }) {
        logger.info({
          module: "tunnels",
          action: "ws.open",
          msg: "tunnel agent connected",
          tenant_id: ws.data.tenant_id,
        });
      },
      async message(
        ws: {
          data: SocketState;
          send: (data: string) => void;
          close: (code?: number, reason?: string) => void;
          readyState: number;
        },
        raw: string | Uint8Array,
      ) {
        const decoded = decodeFrame(raw);
        if (!decoded.ok) {
          ws.send(encodeFrame({ type: "error", code: "bad_frame", message: decoded.error }));
          return;
        }
        const frame = decoded.frame;
        switch (frame.type) {
          case "register": {
            await handleRegister(db, registry, ws, frame);
            return;
          }
          case "response": {
            if (!ws.data.tunnel_name) return;
            // Pick the entry whose target this response is pointing at.
            // The response frame only carries request_id + status — we
            // scan all targets this socket owns and let the registry
            // ignore mismatched ids.
            for (const target of ws.data.targets) {
              registry.deliverResponse(ws.data.tenant_id, target, frame as TunnelResponseFrame);
            }
            return;
          }
          case "ping": {
            ws.send(encodeFrame({ type: "pong", ts: frame.ts }));
            if (ws.data.tunnel_id) {
              await touchTunnelLastSeen(ws.data.tenant_id, ws.data.tunnel_id, db).catch(() => {});
            }
            for (const target of ws.data.targets) {
              registry.touch(ws.data.tenant_id, target);
            }
            return;
          }
          case "pong": {
            for (const target of ws.data.targets) {
              registry.touch(ws.data.tenant_id, target);
            }
            return;
          }
          case "unregister": {
            if (frame.target) {
              ws.data.targets.delete(frame.target);
              registry.detach(ws.data.tenant_id, frame.target);
            } else {
              for (const t of ws.data.targets) {
                registry.detach(ws.data.tenant_id, t);
              }
              ws.data.targets.clear();
            }
            return;
          }
          default:
            return;
        }
      },
      async close(ws: {
        data: SocketState;
        send: (data: string) => void;
        close: (code?: number, reason?: string) => void;
        readyState: number;
      }) {
        if (ws.data.tunnel_id) {
          try {
            await markTunnelDisconnected(ws.data.tenant_id, ws.data.tunnel_id, db);
            await db.transaction(async (tx) => {
              await writeEvent(tx, {
                tenant_id: ws.data.tenant_id,
                channel: "tunnel.state",
                type: "tunnel.disconnected",
                payload: { tunnel_id: ws.data.tunnel_id, name: ws.data.tunnel_name },
              });
            });
          } catch (err) {
            logger.warn({
              module: "tunnels",
              action: "ws.close.persist_failed",
              msg: "failed to persist disconnect",
              error: err instanceof Error ? err.message : String(err),
            });
          }
          audit(
            {
              tenant_id: ws.data.tenant_id,
              actor_type: "system_account",
              actor_id: null,
              action: AuditAction.TUNNEL_DISCONNECTED,
              resource_type: "tunnel",
              resource_id: ws.data.tunnel_id,
              result: "success",
              metadata: { name: ws.data.tunnel_name },
            },
            db,
          );
        }
        for (const target of ws.data.targets) {
          registry.detach(ws.data.tenant_id, target);
        }
        ws.data.targets.clear();
        logger.info({
          module: "tunnels",
          action: "ws.close",
          msg: "tunnel agent disconnected",
          tenant_id: ws.data.tenant_id,
          tunnel_id: ws.data.tunnel_id,
        });
      },
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    port: server.port,
    stop: async () => {
      server.stop(true);
    },
  };
}

async function handleRegister(
  db: Db,
  registry: TunnelRegistry,
  ws: {
    data: SocketState;
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
    readyState: number;
  },
  frame: TunnelRegisterFrame,
): Promise<void> {
  if (ws.data.registered) {
    ws.send(encodeFrame({ type: "error", code: "already_registered", message: "double register" }));
    return;
  }
  const fingerprint = fingerprintAgentToken(ws.data.token);
  const name =
    frame.targets
      .map((t) => t.name)
      .sort()
      .join(",") || "default";
  try {
    const { tunnel } = await upsertTunnel(
      {
        tenant_id: ws.data.tenant_id,
        name,
        agent_token_sha256: fingerprint,
        state: "connected",
        targets: frame.targets.map((t) => ({
          name: t.name,
          local_base_url: t.local_base_url,
        })),
      },
      db,
    );
    ws.data.tunnel_id = tunnel.id;
    ws.data.tunnel_name = tunnel.name;
    ws.data.registered = true;
    log.tunnel.register({
      tunnel_id: tunnel.id,
      tunnel_name: tunnel.name,
      tenant_id: ws.data.tenant_id,
      targets: frame.targets.map((t) => t.name),
    });

    for (const t of frame.targets) {
      registry.attach({
        tunnel_id: tunnel.id,
        tenant_id: ws.data.tenant_id,
        tunnel_name: tunnel.name,
        target: t.name,
        socket: {
          send: (data: string) => ws.send(data),
          close: (code?: number, reason?: string) => ws.close(code, reason),
          readyState: ws.readyState,
        },
        concurrency_cap: 32,
      });
      ws.data.targets.add(t.name);
    }

    await db.transaction(async (tx) => {
      await writeEvent(tx, {
        tenant_id: ws.data.tenant_id,
        channel: "tunnel.state",
        type: "tunnel.connected",
        payload: {
          tunnel_id: tunnel.id,
          name: tunnel.name,
          targets: frame.targets.map((t) => t.name),
        },
      });
    });

    audit(
      {
        tenant_id: ws.data.tenant_id,
        actor_type: "system_account",
        actor_id: null,
        action: AuditAction.TUNNEL_REGISTERED,
        resource_type: "tunnel",
        resource_id: tunnel.id,
        result: "success",
        metadata: { name: tunnel.name, target_count: frame.targets.length },
      },
      db,
    );

    ws.send(encodeFrame({ type: "register_ack", tunnel_id: tunnel.id }));
  } catch (err) {
    logger.error({
      module: "tunnels",
      action: "register.failed",
      msg: "failed to upsert tunnel rows",
      error: err instanceof Error ? err.message : String(err),
    });
    ws.send(
      encodeFrame({
        type: "error",
        code: "register_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    ws.close(1011, "register_failed");
  }
}
