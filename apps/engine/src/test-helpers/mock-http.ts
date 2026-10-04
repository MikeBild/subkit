import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export interface MockServer {
  baseUrl: string;
  setHandler: (h: Handler) => void;
  callCount: () => number;
  close: () => Promise<void>;
}

export async function createMockServer(initial: Handler): Promise<MockServer> {
  let handler: Handler = initial;
  let count = 0;
  const server: Server = createServer(async (req, res) => {
    count += 1;
    try {
      await handler(req, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    setHandler: (h) => {
      handler = h;
    },
    callCount: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
