import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { ProxySiteRules } from "@shared/local-policy/proxy-decision.ts";
import { type FilteringProxy, type ProxyDecisionEvent, startFilteringProxy } from "./proxy.ts";

const SECRET = "test-secret-0001";
const AUTH = `Basic ${btoa(`subkit:${SECRET}`)}`;

const ANSWERS: Record<string, string[]> = {
  "shop.example.com": ["93.184.216.34"],
  "rebind.example.com": ["127.0.0.1"],
  "mixed.example.com": ["93.184.216.34", "10.0.0.7"],
  "v6rebind.example.com": ["::ffff:192.168.0.1"],
};

let upstream: Server;
let upstreamPort = 0;
let proxy: FilteringProxy;
let rules: ProxySiteRules = { mode: "closed" };
const dialed: string[] = [];
const upstreamSockets = new Set<Socket>();
const decisions: ProxyDecisionEvent[] = [];

function workflowRules(): ProxySiteRules {
  return {
    mode: "workflow",
    sites: [
      { origin: "http://shop.example.com", entered_by: "approval" },
      { origin: "https://shop.example.com", entered_by: "approval" },
      { origin: "http://rebind.example.com", entered_by: "approval" },
      { origin: "https://mixed.example.com", entered_by: "approval" },
      { origin: "https://v6rebind.example.com", entered_by: "approval" },
      { origin: "http://unknown.example.com", entered_by: "approval" },
      { origin: `http://127.0.0.1:${upstreamPort}`, entered_by: "person" },
      { origin: "http://192.168.0.20", entered_by: "approval" },
    ],
  };
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.url === "/redirect-out") {
      res.writeHead(302, { location: "https://evil.com/" });
      res.end();
      return;
    }
    if (req.url === "/redirect-in") {
      res.writeHead(302, { location: "/landing" });
      res.end();
      return;
    }
    if (req.url === "/redirect-private") {
      res.writeHead(307, { location: "http://192.168.0.20/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", "x-seen-host": req.headers.host ?? "" });
    res.end(`hello ${req.url}`);
  });
  upstream.on("upgrade", (_req: IncomingMessage, socket: Socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (chunk) => socket.write(chunk));
  });
  upstream.on("connection", (socket: Socket) => upstreamSockets.add(socket));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const address = upstream.address();
  upstreamPort = typeof address === "object" && address ? address.port : 0;
  proxy = await startFilteringProxy({
    secret: SECRET,
    rules: () => rules,
    lookup: async (host) => {
      const answer = ANSWERS[host];
      if (!answer) throw new Error("ENOTFOUND");
      return answer;
    },
    route: (address) => {
      dialed.push(address);
      return { host: "127.0.0.1", port: upstreamPort };
    },
    onDecision: (event) => decisions.push(event),
  });
});

afterAll(async () => {
  await proxy.close();
  for (const socket of upstreamSockets) socket.destroy();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

interface Answer {
  status: number;
  refusal: string | undefined;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function viaProxy(url: string, auth: string | null = AUTH): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "GET",
      path: url,
      headers: auth === null ? {} : { "proxy-authorization": auth },
      agent: false,
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          refusal: res.headers["x-subkit-refusal"] as string | undefined,
          body,
          headers: res.headers,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function rawExchange(text: string): Promise<{ head: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: proxy.port });
    let buffer = "";
    socket.setEncoding("utf8");
    const onData = (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      resolve({ head: buffer.slice(0, end), socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.write(text);
  });
}

function connectVia(authority: string, auth: string | null = AUTH) {
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (auth !== null) lines.push(`Proxy-Authorization: ${auth}`);
  return rawExchange(`${lines.join("\r\n")}\r\n\r\n`);
}

function readUntil(socket: Socket, marker: string): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: string | Buffer) => {
      buffer += chunk.toString();
      if (!buffer.includes(marker)) return;
      socket.off("data", onData);
      resolve(buffer);
    };
    socket.on("data", onData);
  });
}

function closed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
  });
}

describe("filtering proxy authentication", () => {
  test("requests without the per-launch secret get 407", async () => {
    rules = workflowRules();
    expect((await viaProxy("http://shop.example.com/", null)).status).toBe(407);
    expect(
      (await viaProxy("http://shop.example.com/", `Basic ${btoa("subkit:wrong")}`)).status,
    ).toBe(407);
    const tunnel = await connectVia("shop.example.com:443", null);
    expect(tunnel.head).toStartWith("HTTP/1.1 407");
    expect(tunnel.head).toContain('Proxy-Authenticate: Basic realm="SubKit"');
    tunnel.socket.destroy();
  });

  test("the proxy URL carries the secret and listens on loopback only", () => {
    expect(proxy.url).toBe(`http://subkit:${SECRET}@127.0.0.1:${proxy.port}`);
  });
});

describe("filtering proxy decisions on loopback", () => {
  test("an allowed site is fetched from the address resolved once", async () => {
    rules = workflowRules();
    dialed.length = 0;
    const answer = await viaProxy("http://shop.example.com/page?q=1");
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("hello /page?q=1");
    expect(answer.headers["x-seen-host"]).toBe("shop.example.com");
    expect(dialed).toEqual(["93.184.216.34"]);
  });

  test("DNS rebinding to loopback or a mapped private IPv6 is refused before dialing", async () => {
    rules = workflowRules();
    dialed.length = 0;
    const rebind = await viaProxy("http://rebind.example.com/");
    expect(rebind.status).toBe(403);
    expect(rebind.refusal).toBe("private_address");
    const mixed = await connectVia("mixed.example.com:443");
    expect(mixed.head).toStartWith("HTTP/1.1 403");
    expect(mixed.head).toContain("x-subkit-refusal: private_address");
    mixed.socket.destroy();
    const mapped = await connectVia("v6rebind.example.com:443");
    expect(mapped.head).toContain("x-subkit-refusal: private_address");
    mapped.socket.destroy();
    expect(dialed).toEqual([]);
  });

  test("a site outside the list, a credential URL and an unknown name are refused", async () => {
    rules = workflowRules();
    const other = await viaProxy("http://other.example.com/");
    expect([other.status, other.refusal]).toEqual([403, "origin_not_allowed"]);
    const credential = await viaProxy("http://user:pw@shop.example.com/");
    expect([credential.status, credential.refusal]).toEqual([403, "origin_not_allowed"]);
    const unknown = await viaProxy("http://unknown.example.com/");
    expect([unknown.status, unknown.refusal]).toEqual([502, "unresolved"]);
  });

  test("redirects are checked at every hop", async () => {
    rules = workflowRules();
    const out = await viaProxy("http://shop.example.com/redirect-out");
    expect([out.status, out.refusal]).toEqual([403, "origin_not_allowed"]);
    const inside = await viaProxy("http://shop.example.com/redirect-in");
    expect(inside.status).toBe(302);
    expect(inside.headers.location).toBe("/landing");
    const toPrivate = await viaProxy("http://shop.example.com/redirect-private");
    expect([toPrivate.status, toPrivate.refusal]).toEqual([403, "private_address"]);
    expect(decisions.some((event) => event.kind === "redirect" && !event.allowed)).toBe(true);
  });

  test("a private address passes only when the person entered it", async () => {
    rules = workflowRules();
    dialed.length = 0;
    const entered = await viaProxy(`http://127.0.0.1:${upstreamPort}/`);
    expect(entered.status).toBe(200);
    expect(dialed).toEqual(["127.0.0.1"]);
    const suggested = await viaProxy("http://192.168.0.20/");
    expect([suggested.status, suggested.refusal]).toEqual([403, "private_address"]);
    const loopbackV6 = await connectVia("[::1]:443");
    expect(loopbackV6.head).toContain("x-subkit-refusal: private_address");
    loopbackV6.socket.destroy();
  });

  test("personal mode refuses unentered ports", async () => {
    rules = { mode: "personal", options: { entered_by_person: [] } };
    const port = await connectVia("shop.example.com:8443");
    expect(port.head).toContain("x-subkit-refusal: origin_not_allowed");
    port.socket.destroy();
    const ok = await viaProxy("http://shop.example.com/");
    expect(ok.status).toBe(200);
  });

  test("closed rules refuse everything", async () => {
    rules = { mode: "closed" };
    const answer = await viaProxy("http://shop.example.com/");
    expect([answer.status, answer.refusal]).toEqual([403, "origin_not_allowed"]);
  });

  test("an origin-form request is not a proxy request", async () => {
    rules = workflowRules();
    const answer = await viaProxy("/local");
    expect([answer.status, answer.refusal]).toEqual([403, "origin_not_allowed"]);
  });
});

describe("tunnels and websockets", () => {
  test("an allowed CONNECT tunnels bytes to the pinned address", async () => {
    rules = workflowRules();
    dialed.length = 0;
    const tunnel = await connectVia("shop.example.com:443");
    expect(tunnel.head).toBe("HTTP/1.1 200 Connection Established");
    const reply = readUntil(tunnel.socket, "hello /through");
    tunnel.socket.write(
      "GET /through HTTP/1.1\r\nHost: shop.example.com\r\nConnection: close\r\n\r\n",
    );
    expect(await reply).toContain("hello /through");
    expect(dialed).toEqual(["93.184.216.34"]);
    tunnel.socket.destroy();
  });

  test("a tunnel to a person-entered plain http origin on its port is allowed", async () => {
    rules = workflowRules();
    dialed.length = 0;
    const tunnel = await connectVia(`127.0.0.1:${upstreamPort}`);
    expect(tunnel.head).toBe("HTTP/1.1 200 Connection Established");
    expect(dialed).toEqual(["127.0.0.1"]);
    tunnel.socket.destroy();
    const other = await connectVia("127.0.0.1:1");
    expect(other.head).toContain("x-subkit-refusal: private_address");
    other.socket.destroy();
  });

  test("a websocket upgrade is checked like a request", async () => {
    rules = workflowRules();
    const allowed = await rawExchange(
      `GET http://shop.example.com/socket HTTP/1.1\r\nHost: shop.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nProxy-Authorization: ${AUTH}\r\n\r\n`,
    );
    expect(allowed.head).toStartWith("HTTP/1.1 101");
    const echo = readUntil(allowed.socket, "ping");
    allowed.socket.write("ping");
    expect(await echo).toBe("ping");
    allowed.socket.destroy();
    const refused = await rawExchange(
      `GET http://rebind.example.com/socket HTTP/1.1\r\nHost: rebind.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nProxy-Authorization: ${AUTH}\r\n\r\n`,
    );
    expect(refused.head).toContain("x-subkit-refusal: private_address");
    refused.socket.destroy();
    const unauthorized = await rawExchange(
      "GET http://shop.example.com/socket HTTP/1.1\r\nHost: shop.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    expect(unauthorized.head).toStartWith("HTTP/1.1 407");
    unauthorized.socket.destroy();
  });

  test("closing connections ends open tunnels", async () => {
    rules = workflowRules();
    const tunnel = await connectVia("shop.example.com:443");
    expect(tunnel.head).toBe("HTTP/1.1 200 Connection Established");
    const ended = closed(tunnel.socket);
    proxy.closeConnections();
    await ended;
    expect(tunnel.socket.destroyed).toBe(true);
  });
});
