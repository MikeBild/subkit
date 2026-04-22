// TCP passthrough relay for the tunnel agent.
//
// Opens a short-lived TCP socket to the requested host:port on the
// agent-local network, writes the raw payload bytes, reads whatever the
// remote host writes back until it closes (or we hit a timeout), then
// replies with base64-encoded response bytes.
//
// Intended for one-shot protocol probes — e.g. a Postgres startup
// message, a Redis PING, an FTP banner. Long-lived protocol sessions
// with interactive I/O need a streaming variant (follow-up).

import net from "node:net";

export interface TcpRelayRequest {
  host: string;
  port: number;
  /** base64-encoded payload to write once the socket opens. */
  body: string | null;
  timeoutMs?: number;
}

export interface TcpRelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
  error: string | null;
}

export async function tcpRelay(req: TcpRelayRequest): Promise<TcpRelayResponse> {
  const timeout = req.timeoutMs ?? 15_000;
  return await new Promise<TcpRelayResponse>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (result: TcpRelayResponse): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
      resolve(result);
    };
    const socket = net.connect({ host: req.host, port: req.port });
    socket.setTimeout(timeout);
    socket.on("connect", () => {
      if (req.body) {
        try {
          socket.write(Buffer.from(req.body, "base64"));
        } catch (err) {
          done({
            status: 0,
            headers: {},
            body: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("timeout", () => {
      done({
        status: 0,
        headers: {},
        body: chunks.length > 0 ? Buffer.concat(chunks).toString("base64") : null,
        error: "timeout",
      });
    });
    socket.on("end", () => {
      done({
        status: 200,
        headers: {},
        body: Buffer.concat(chunks).toString("base64"),
        error: null,
      });
    });
    socket.on("error", (err: Error) => {
      done({
        status: 0,
        headers: {},
        body: null,
        error: err.message,
      });
    });
  });
}
