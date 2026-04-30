// TCP passthrough over an existing HTTP-grade tunnel. Lets non-HTTP
// drivers (postgres, redis, ftp, mssql, smb, …) route their client
// traffic through the on-prem tunnel agent without re-implementing
// each protocol engine-side.
//
// Shape: one request frame carrying base64-encoded raw bytes, one
// response frame carrying the bytes the target wrote back. Short-lived
// TCP sockets only — if a driver needs a long-lived connection with
// interactive I/O it has to adopt a streaming variant (follow-up).
//
// Usage from a driver:
//
//   const response = await tunnelTcpRoundtrip({
//     tenant_id,
//     tunnel_target,
//     host: "db.internal",
//     port: 5432,
//     payload: Buffer.from(postgresStartupMessage),
//   });
//
// Returns the bytes the remote host wrote before closing the socket
// (or timing out).
//
// Agent side: apps/agent/src/client.ts handles `protocol === "tcp"`
// frames and delegates to `apps/agent/src/tcp-relay.ts` which opens a
// short-lived `net.connect`, writes the payload, reads the reply
// until the remote side closes (or the socket times out), and
// returns base64-encoded response bytes. End-to-end functional today.

import { tunnelRegistry } from "./registry.ts";
import type { TunnelResponse } from "./types.ts";

export interface TunnelTcpRoundtripParams {
  tenant_id: string;
  tunnel_target: string;
  host: string;
  port: number;
  payload: Buffer;
  timeoutMs?: number;
}

export interface TunnelTcpRoundtripResult {
  status: number;
  response: Buffer;
  error: string | null;
}

export async function tunnelTcpRoundtrip(
  params: TunnelTcpRoundtripParams,
): Promise<TunnelTcpRoundtripResult> {
  const base64Payload = params.payload.toString("base64");
  const resp: TunnelResponse = await tunnelRegistry.forwardRequest(
    params.tenant_id,
    params.tunnel_target,
    {
      target: params.tunnel_target,
      method: "TCP",
      path: `/${params.host}:${params.port}`,
      headers: {},
      body: base64Payload,
      protocol: "tcp",
      tcp_host: params.host,
      tcp_port: params.port,
    },
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {},
  );
  const response = resp.body ? Buffer.from(resp.body, "base64") : Buffer.alloc(0);
  return {
    status: resp.status,
    response,
    error: resp.error ?? null,
  };
}
