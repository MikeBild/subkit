// In-process registry for live tunnel sockets.
//
// Keyed by (tenant_id, target_name). Each entry owns the socket reference,
// a counter of in-flight requests, and a map of request_id -> resolver so
// `forwardRequest()` can correlate incoming `response` frames back to the
// caller. On disconnect, pending resolvers are rejected so nothing hangs.

import { logger } from "../logging/logger.ts";
import { setTunnelConnected } from "../observability/instrumentation.ts";
import { encodeFrame, type TunnelResponseFrame } from "./framing.ts";
import {
  TunnelCapacityError,
  TunnelDisconnectedError,
  TunnelNotFoundError,
  type TunnelRequest,
  type TunnelResponse,
  type TunnelSocket,
  TunnelTimeoutError,
} from "./types.ts";

export interface TunnelEntry {
  tunnel_id: string;
  tenant_id: string;
  tunnel_name: string;
  target: string;
  socket: TunnelSocket;
  concurrency_cap: number;
  in_flight: Map<string, PendingRequest>;
  last_seen_ms: number;
}

interface PendingRequest {
  resolve: (res: TunnelResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function key(tenant_id: string, target: string): string {
  return `${tenant_id}::${target}`;
}

export class TunnelRegistry {
  private readonly entries = new Map<string, TunnelEntry>();

  /** Register a live target slot. Overwrites any previous entry for the same key. */
  attach(entry: Omit<TunnelEntry, "in_flight" | "last_seen_ms">): TunnelEntry {
    const existing = this.entries.get(key(entry.tenant_id, entry.target));
    if (existing) {
      // Reject outstanding requests on the previous socket so they fail fast
      // rather than stall against a dead connection.
      this.rejectAll(existing, new TunnelDisconnectedError("replaced by new connection"));
    }
    const full: TunnelEntry = {
      ...entry,
      in_flight: new Map(),
      last_seen_ms: Date.now(),
    };
    this.entries.set(key(entry.tenant_id, entry.target), full);
    setTunnelConnected({
      tenant_id: entry.tenant_id,
      target: entry.target,
      connected: true,
    });
    return full;
  }

  /** Remove an entry. Rejects any pending resolvers with disconnect. */
  detach(tenant_id: string, target: string): void {
    const k = key(tenant_id, target);
    const entry = this.entries.get(k);
    if (!entry) return;
    this.rejectAll(entry, new TunnelDisconnectedError());
    this.entries.delete(k);
    setTunnelConnected({ tenant_id, target, connected: false });
  }

  get(tenant_id: string, target: string): TunnelEntry | undefined {
    return this.entries.get(key(tenant_id, target));
  }

  touch(tenant_id: string, target: string): void {
    const e = this.entries.get(key(tenant_id, target));
    if (e) e.last_seen_ms = Date.now();
  }

  /** Called when the socket receives a `response` frame. */
  deliverResponse(tenant_id: string, target: string, frame: TunnelResponseFrame): void {
    const entry = this.entries.get(key(tenant_id, target));
    if (!entry) return;
    const pending = entry.in_flight.get(frame.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    entry.in_flight.delete(frame.request_id);
    if (frame.error) {
      pending.reject(new Error(frame.error));
      return;
    }
    pending.resolve({
      status: frame.status,
      headers: frame.headers,
      body: frame.body ?? null,
    });
  }

  /**
   * Forward a request frame to the agent and await its response.
   *
   * Bounded by `opts.timeoutMs` (default 60_000) and the per-target
   * concurrency cap. Rejects with {@link TunnelNotFoundError} when no live
   * socket is registered, {@link TunnelCapacityError} when the cap is hit,
   * and {@link TunnelTimeoutError} / {@link TunnelDisconnectedError} on the
   * respective terminal conditions.
   */
  async forwardRequest(
    tenant_id: string,
    target: string,
    req: TunnelRequest,
    opts: { timeoutMs?: number } = {},
  ): Promise<TunnelResponse> {
    const entry = this.entries.get(key(tenant_id, target));
    if (!entry) throw new TunnelNotFoundError(target);
    if (entry.in_flight.size >= entry.concurrency_cap) {
      throw new TunnelCapacityError();
    }
    const request_id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const timeoutMs = opts.timeoutMs ?? 60_000;

    return await new Promise<TunnelResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.in_flight.delete(request_id);
        reject(new TunnelTimeoutError());
      }, timeoutMs);
      entry.in_flight.set(request_id, { resolve, reject, timer });
      try {
        const frame: Parameters<typeof encodeFrame>[0] = {
          type: "request",
          request_id,
          target,
          method: req.method,
          path: req.path,
          headers: req.headers,
          body: req.body ?? null,
        };
        if (req.protocol) {
          (frame as { protocol?: "http" | "tcp" }).protocol = req.protocol;
        }
        if (req.tcp_host !== undefined) {
          (frame as { tcp_host?: string }).tcp_host = req.tcp_host;
        }
        if (req.tcp_port !== undefined) {
          (frame as { tcp_port?: number }).tcp_port = req.tcp_port;
        }
        entry.socket.send(encodeFrame(frame));
      } catch (err) {
        clearTimeout(timer);
        entry.in_flight.delete(request_id);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      logger.debug({
        module: "tunnels",
        action: "request.forwarded",
        msg: "tunnel request forwarded",
        tenant_id,
        target,
        request_id,
        protocol: req.protocol ?? "http",
        method: req.method,
        path: req.path,
      });
    });
  }

  /** Debug/monitoring snapshot of all currently held entries. */
  stats(): Array<{
    tenant_id: string;
    target: string;
    in_flight: number;
    last_seen_ms: number;
    concurrency_cap: number;
  }> {
    const out: Array<{
      tenant_id: string;
      target: string;
      in_flight: number;
      last_seen_ms: number;
      concurrency_cap: number;
    }> = [];
    for (const [, entry] of this.entries) {
      out.push({
        tenant_id: entry.tenant_id,
        target: entry.target,
        in_flight: entry.in_flight.size,
        last_seen_ms: entry.last_seen_ms,
        concurrency_cap: entry.concurrency_cap,
      });
    }
    return out;
  }

  /** Number of registered entries — used by tests. */
  size(): number {
    return this.entries.size;
  }

  private rejectAll(entry: TunnelEntry, err: Error): void {
    for (const [, pending] of entry.in_flight) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    entry.in_flight.clear();
  }
}

// Shared process-wide instance — the HTTP driver and the WS endpoint both
// import this so there is exactly one routing table per engine process.
export const tunnelRegistry = new TunnelRegistry();
