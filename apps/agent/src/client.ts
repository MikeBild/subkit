// Tunnel agent WebSocket client.
//
// Opens a single persistent connection to the engine, sends a `register`
// frame with the configured target list, then answers inbound `request`
// frames by doing a real local fetch and replying with a `response` frame.
//
// Connection management:
//   - Exponential backoff reconnect starting at 500 ms, capped at 30 s.
//   - Ping/pong keepalive every 15 s; mark dead after 45 s of silence.
//   - Buffers nothing — on disconnect the engine's resolvers reject and
//     the caller re-issues.

import WebSocket from "ws";
import { agentFetch } from "./fetch.ts";
import { log } from "./logger.ts";
import { tcpRelay } from "./tcp-relay.ts";

export interface AgentTargetConfig {
  name: string;
  local_base_url: string;
}

export interface AgentClientOptions {
  engine_url: string;
  api_key: string;
  targets: AgentTargetConfig[];
  agent_version?: string;
  ping_interval_ms?: number;
  dead_after_ms?: number;
  min_backoff_ms?: number;
  max_backoff_ms?: number;
  // Test seam — if set, stop reconnecting after this many consecutive failures.
  max_reconnects?: number;
}

type FrameIn =
  | {
      type: "register_ack";
      tunnel_id: string;
    }
  | {
      type: "request";
      request_id: string;
      target: string;
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: string | null;
      /** Optional — defaults to "http" for backwards-compat. */
      protocol?: "http" | "tcp";
      /** Required when `protocol === "tcp"`. */
      tcp_host?: string;
      tcp_port?: number;
    }
  | { type: "pong"; ts: number }
  | { type: "ping"; ts: number }
  | { type: "error"; code: string; message: string };

export class TunnelAgentClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastInboundMs = 0;
  private consecutiveFailures = 0;
  private stopped = false;
  private readonly targets = new Map<string, AgentTargetConfig>();

  constructor(private readonly opts: AgentClientOptions) {
    for (const t of opts.targets) this.targets.set(t.name, t);
  }

  /** Start the client. Returns a promise that resolves on the first ack. */
  async start(): Promise<void> {
    this.stopped = false;
    return await new Promise<void>((resolve, reject) => {
      const attempt = (): void => {
        if (this.stopped) return;
        this.connectOnce()
          .then((openedPromise) => {
            openedPromise
              .then(() => resolve())
              .catch((err) => {
                if (
                  this.opts.max_reconnects !== undefined &&
                  this.consecutiveFailures >= this.opts.max_reconnects
                ) {
                  reject(err);
                  return;
                }
                scheduleReconnect();
              });
          })
          .catch((err) => {
            this.consecutiveFailures += 1;
            if (
              this.opts.max_reconnects !== undefined &&
              this.consecutiveFailures >= this.opts.max_reconnects
            ) {
              reject(err);
              return;
            }
            scheduleReconnect();
          });
      };
      const scheduleReconnect = (): void => {
        if (this.stopped) return;
        const base = this.opts.min_backoff_ms ?? 500;
        const max = this.opts.max_backoff_ms ?? 30_000;
        const delay = Math.min(max, base * 2 ** Math.min(8, this.consecutiveFailures));
        log.warn("reconnecting", { delay_ms: delay, attempt: this.consecutiveFailures + 1 });
        setTimeout(attempt, delay).unref?.();
      };
      attempt();
    });
  }

  /** Stop the client and close the socket. */
  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.pingTimer = null;
    this.watchdog = null;
    this.ws?.close();
    this.ws = null;
  }

  private async connectOnce(): Promise<Promise<void>> {
    return await new Promise<Promise<void>>((resolveConnected, rejectConnected) => {
      const url = `${this.opts.engine_url.replace(/\/$/, "")}/v1/tunnels/ws`;
      log.info("connecting", { url });
      const ws = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${this.opts.api_key}`,
        },
      });
      this.ws = ws;
      const ackPromise = new Promise<void>((resolveAck, rejectAck) => {
        ws.once("open", () => {
          log.info("socket open");
          this.lastInboundMs = Date.now();
          // Send the register frame immediately.
          ws.send(
            JSON.stringify({
              type: "register",
              agent_version: this.opts.agent_version ?? "0.0.0",
              targets: this.opts.targets.map((t) => ({
                name: t.name,
                local_base_url: t.local_base_url,
              })),
            }),
          );
          this.startKeepalive();
          resolveConnected(ackPromise);
        });
        ws.on("message", (raw) => {
          this.lastInboundMs = Date.now();
          let text: string;
          if (typeof raw === "string") text = raw;
          else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
          else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
          else text = String(raw);
          let parsed: FrameIn;
          try {
            parsed = JSON.parse(text) as FrameIn;
          } catch {
            log.warn("bad frame", { raw: text.slice(0, 256) });
            return;
          }
          this.onFrame(parsed, ws).catch((err) => {
            log.error("frame handler failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          if (parsed.type === "register_ack") {
            this.consecutiveFailures = 0;
            resolveAck();
          }
          if (parsed.type === "error") {
            rejectAck(new Error(`${parsed.code}: ${parsed.message}`));
          }
        });
        ws.on("close", (code, reason) => {
          log.warn("socket closed", { code, reason: reason.toString("utf8") });
          this.stopKeepalive();
          if (this.lastInboundMs === 0) {
            rejectAck(new Error(`closed before ack: ${code}`));
          }
        });
        ws.on("error", (err) => {
          log.error("socket error", { error: err.message });
          rejectAck(err);
          rejectConnected(err);
        });
      });
    });
  }

  private startKeepalive(): void {
    const interval = this.opts.ping_interval_ms ?? 15_000;
    const dead = this.opts.dead_after_ms ?? 45_000;
    this.stopKeepalive();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch {}
    }, interval);
    this.pingTimer.unref?.();
    this.watchdog = setInterval(
      () => {
        if (Date.now() - this.lastInboundMs > dead) {
          log.warn("dead connection, forcing reconnect");
          this.ws?.terminate();
        }
      },
      Math.max(1_000, Math.floor(interval / 2)),
    );
    this.watchdog.unref?.();
  }

  private stopKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.pingTimer = null;
    this.watchdog = null;
  }

  private async onFrame(frame: FrameIn, ws: WebSocket): Promise<void> {
    switch (frame.type) {
      case "request": {
        const target = this.targets.get(frame.target);
        if (!target) {
          ws.send(
            JSON.stringify({
              type: "response",
              request_id: frame.request_id,
              status: 0,
              headers: {},
              body: null,
              error: `unknown target '${frame.target}'`,
            }),
          );
          return;
        }
        if (frame.protocol === "tcp") {
          if (!frame.tcp_host || frame.tcp_port === undefined) {
            ws.send(
              JSON.stringify({
                type: "response",
                request_id: frame.request_id,
                status: 0,
                headers: {},
                body: null,
                error: "tcp protocol requires tcp_host + tcp_port",
              }),
            );
            return;
          }
          const tcp = await tcpRelay({
            host: frame.tcp_host,
            port: frame.tcp_port,
            body: frame.body ?? null,
          });
          ws.send(
            JSON.stringify({
              type: "response",
              request_id: frame.request_id,
              status: tcp.status,
              headers: tcp.headers,
              body: tcp.body,
              error: tcp.error,
            }),
          );
          return;
        }
        const res = await agentFetch({
          local_base_url: target.local_base_url,
          method: frame.method,
          path: frame.path,
          headers: frame.headers,
          body: frame.body ?? null,
        });
        ws.send(
          JSON.stringify({
            type: "response",
            request_id: frame.request_id,
            status: res.status,
            headers: res.headers,
            body: res.body,
            error: res.error ?? null,
          }),
        );
        return;
      }
      case "ping":
        ws.send(JSON.stringify({ type: "pong", ts: frame.ts }));
        return;
      case "pong":
      case "register_ack":
      case "error":
        return;
    }
  }
}
