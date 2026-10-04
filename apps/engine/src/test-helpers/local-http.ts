import http from "node:http";

export function startLocalTargetServer(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<{ url: string; stop: () => Promise<void> }> {
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
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("startLocalTargetServer: server did not bind a TCP address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        stop: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
