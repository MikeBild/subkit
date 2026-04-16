// Shared types for the tunnel subsystem.

export class TunnelError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "TunnelError";
  }
}

export class TunnelTimeoutError extends TunnelError {
  constructor(message = "tunnel request timed out") {
    super("tunnel_timeout", message);
    this.name = "TunnelTimeoutError";
  }
}

export class TunnelDisconnectedError extends TunnelError {
  constructor(message = "tunnel disconnected") {
    super("tunnel_disconnected", message);
    this.name = "TunnelDisconnectedError";
  }
}

export class TunnelNotFoundError extends TunnelError {
  constructor(target: string) {
    super("tunnel_not_found", `no live tunnel for target '${target}'`);
    this.name = "TunnelNotFoundError";
  }
}

export class TunnelCapacityError extends TunnelError {
  constructor(message = "tunnel per-target concurrency cap reached") {
    super("tunnel_capacity", message);
    this.name = "TunnelCapacityError";
  }
}

/** Minimal WebSocket contract the registry depends on. */
export interface TunnelSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

export interface TunnelRequest {
  target: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | null;
}

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body?: string | null;
  error?: string | null;
}

export interface ConnectedTunnel {
  tunnel_id: string;
  tenant_id: string;
  name: string;
  targets: string[];
  socket: TunnelSocket;
  connected_at: number;
  last_seen_at: number;
}
