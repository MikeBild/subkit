// Minimal local HTTP target server for tests that need a real loopback
// origin. Uses node:http instead of Bun.serve because Bun.serve's handler
// registration becomes flaky under heavy parallel load in bun test,
// occasionally returning the default "Welcome to Bun" response instead of
// invoking the handler.

export function startLocalTargetServer(handler: (req: Request) => Response | Promise<Response>): {
  url: string;
  stop: () => Promise<void>;
} {
  const http = require("node:http") as typeof import("node:http");
  const server = http.createServer(async (nodeReq, nodeRes) => {
    const chunks: Buffer[] = [];
    for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = `http://${nodeReq.headers.host ?? "127.0.0.1"}${nodeReq.url ?? "/"}`;
    const init: RequestInit = {
      method: nodeReq.method ?? "GET",
      headers: nodeReq.headers as Record<string, string>,
    };
    if (body.length > 0 && nodeReq.method !== "GET" && nodeReq.method !== "HEAD") {
      init.body = body;
    }
    const req = new Request(url, init);
    const res = await handler(req);
    nodeRes.statusCode = res.status;
    res.headers.forEach((value, key) => {
      nodeRes.setHeader(key, value);
    });
    const resText = await res.text();
    nodeRes.end(resText);
  });
  server.listen(0, "127.0.0.1");
  const addr = server.address();
  let port: number;
  if (addr && typeof addr === "object") {
    port = addr.port;
  } else {
    const start = Date.now();
    while (Date.now() - start < 1000) {
      const a = server.address();
      if (a && typeof a === "object") {
        port = a.port;
        break;
      }
    }
    port ??= 0;
  }
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
