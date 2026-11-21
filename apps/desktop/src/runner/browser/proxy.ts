import { createHash, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isIpLiteral } from "@shared/local-policy/addresses.ts";
import {
  chooseConnectTarget,
  type ProxySiteRules,
  type ProxyTarget,
  pickAddress,
  proxyCredentials,
  proxyUrl,
  redirectAllowed,
  refusalStatus,
  requestTarget,
  targetAllowed,
} from "@shared/local-policy/proxy-decision.ts";

export type ProxyLookup = (host: string) => Promise<string[]>;
export interface ProxyEndpoint {
  readonly host: string;
  readonly port: number;
}
export type ProxyRoute = (address: string, port: number) => ProxyEndpoint;

export type ProxyRequestKind = "request" | "connect" | "upgrade" | "redirect";

export interface ProxyDecisionEvent {
  readonly kind: ProxyRequestKind;
  readonly origin: string | null;
  readonly allowed: boolean;
  readonly code?: string;
}

export interface FilteringProxyOptions {
  readonly secret: string;
  readonly rules: () => ProxySiteRules;
  readonly lookup?: ProxyLookup;
  readonly route?: ProxyRoute;
  readonly onDecision?: (event: ProxyDecisionEvent) => void;
}

export interface FilteringProxy {
  readonly port: number;
  readonly url: string;
  closeConnections(): void;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const REFUSAL_HEADER = "x-subkit-refusal";

function bare(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

async function systemLookup(host: string): Promise<string[]> {
  const answers = await dnsLookup(host, { all: true, order: "verbatim" });
  return answers.map((answer) => answer.address);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function forwardHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) result[name] = value;
  }
  return result;
}

function rawResponse(status: number, reason: string, extra: Record<string, string> = {}): string {
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (const [name, value] of Object.entries({ ...extra, "Content-Length": "0" }))
    lines.push(`${name}: ${value}`);
  lines.push("Connection: close", "", "");
  return lines.join("\r\n");
}

const AUTH_REQUIRED = {
  "Proxy-Authenticate": 'Basic realm="SubKit"',
};

type Resolved =
  | { ok: true; target: ProxyTarget; address: string }
  | { ok: false; status: number; code: string; origin: string | null };

export async function startFilteringProxy(options: FilteringProxyOptions): Promise<FilteringProxy> {
  const lookup = options.lookup ?? systemLookup;
  const route = options.route ?? ((address, port) => ({ host: address, port }));
  const dial = (address: string, port: number): Socket => netConnect(route(address, port));
  const expected = digest(options.secret);
  const sockets = new Set<Duplex>();

  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const authorized = (header: string | undefined) => {
    const secret = proxyCredentials(header);
    return secret !== null && timingSafeEqual(digest(secret), expected);
  };

  const report = (kind: ProxyRequestKind, origin: string | null, code?: string) =>
    options.onDecision?.(
      code === undefined ? { kind, origin, allowed: true } : { kind, origin, allowed: false, code },
    );

  const resolve = async (
    kind: ProxyRequestKind,
    target: ProxyTarget | null,
    scheme: "http" | "any",
  ): Promise<Resolved> => {
    if (target === null || (scheme === "http" && !target.url.startsWith("http://"))) {
      report(kind, null, "origin_not_allowed");
      return { ok: false, status: 403, code: "origin_not_allowed", origin: null };
    }
    const rules = options.rules();
    const allowed = targetAllowed(target, rules);
    if (!allowed.ok) {
      report(kind, target.origin, allowed.code);
      return { ok: false, status: 403, code: allowed.code, origin: target.origin };
    }
    const host = bare(target.host);
    const addresses = isIpLiteral(host) ? [host] : await lookup(host).catch(() => []);
    const choice = pickAddress(target, addresses, rules);
    if (!choice.ok) {
      report(kind, target.origin, choice.code);
      return {
        ok: false,
        status: refusalStatus(choice.code),
        code: choice.code,
        origin: target.origin,
      };
    }
    report(kind, target.origin);
    return { ok: true, target, address: choice.address };
  };

  const refuseResponse = (res: ServerResponse, status: number, code: string) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { [REFUSAL_HEADER]: code, "content-length": "0", connection: "close" });
    res.end();
  };

  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req.headers["proxy-authorization"])) {
      res.writeHead(407, { ...AUTH_REQUIRED, "content-length": "0", connection: "close" });
      res.end();
      return;
    }
    const resolved = await resolve("request", requestTarget(req.url ?? ""), "http");
    if (!resolved.ok) return refuseResponse(res, resolved.status, resolved.code);
    const { target, address } = resolved;
    const path = target.url.slice(target.origin.length) || "/";
    const endpoint = route(address, target.port);
    const upstream = httpRequest({
      host: endpoint.host,
      port: endpoint.port,
      method: req.method,
      path,
      headers: { ...forwardHeaders(req.headers), host: target.origin.replace(/^https?:\/\//, "") },
      setHost: false,
      agent: false,
    });
    upstream.on("response", (answer) => {
      const status = answer.statusCode ?? 502;
      const location = answer.headers.location;
      const hop = redirectAllowed(target.url, status, location, options.rules());
      if (!hop.ok) {
        report("redirect", target.origin, hop.code);
        answer.destroy();
        return refuseResponse(res, 403, hop.code);
      }
      res.writeHead(status, forwardHeaders(answer.headers));
      answer.pipe(res);
    });
    upstream.on("error", () => refuseResponse(res, 502, "upstream_failed"));
    req.pipe(upstream);
  };

  const tunnel = (client: Duplex, address: string, port: number, onOpen: (up: Socket) => void) => {
    const upstream = dial(address, port);
    track(upstream);
    upstream.once("connect", () => {
      onOpen(upstream);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      client.end(rawResponse(502, "Bad Gateway"));
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  };

  const onConnect = async (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on("error", () => {});
    if (!authorized(req.headers["proxy-authorization"])) {
      client.end(rawResponse(407, "Proxy Authentication Required", AUTH_REQUIRED));
      return;
    }
    const resolved = await resolve(
      "connect",
      chooseConnectTarget(req.url ?? "", options.rules()),
      "any",
    );
    if (!resolved.ok) {
      client.end(rawResponse(resolved.status, "Refused", { [REFUSAL_HEADER]: resolved.code }));
      return;
    }
    tunnel(client, resolved.address, resolved.target.port, (upstream) => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
    });
  };

  const onUpgrade = async (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on("error", () => {});
    if (!authorized(req.headers["proxy-authorization"])) {
      client.end(rawResponse(407, "Proxy Authentication Required", AUTH_REQUIRED));
      return;
    }
    const resolved = await resolve("upgrade", requestTarget(req.url ?? ""), "http");
    if (!resolved.ok) {
      client.end(rawResponse(resolved.status, "Refused", { [REFUSAL_HEADER]: resolved.code }));
      return;
    }
    const { target } = resolved;
    const lines = [`${req.method} ${target.url.slice(target.origin.length) || "/"} HTTP/1.1`];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index] as string;
      if (!name.toLowerCase().startsWith("proxy-"))
        lines.push(`${name}: ${req.rawHeaders[index + 1]}`);
    }
    tunnel(client, resolved.address, target.port, (upstream) => {
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
    });
  };

  const server = createServer((req, res) => void onRequest(req, res));
  server.on("connect", (req, socket, head) => void onConnect(req, socket, head));
  server.on("upgrade", (req, socket, head) => void onUpgrade(req, socket, head));
  server.on("connection", (socket) => track(socket));

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const closeConnections = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };

  return {
    port,
    url: proxyUrl(port, options.secret),
    closeConnections,
    close() {
      closeConnections();
      server.closeAllConnections();
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
