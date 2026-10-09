import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockOAuthServer {
  baseUrl: string;
  issuedCount: () => number;
  lastGrantType: () => string | null;
  close: () => Promise<void>;
  setExpiresIn: (seconds: number) => void;
  setGrantedScope: (scope: string | null) => void;
  setSubject: (subject: string | null) => void;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseForm(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split("&")) {
    if (!pair) continue;
    const [k, v] = pair.split("=");
    out[decodeURIComponent(k ?? "")] = decodeURIComponent(v ?? "");
  }
  return out;
}

export async function startMockOAuthServer(): Promise<MockOAuthServer> {
  let issued = 0;
  let lastGrant: string | null = null;
  let expiresIn = 3600;
  let grantedScope: string | null = null;
  let subject: string | null = null;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/.well-known/openid-configuration") {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            response_types_supported: ["code", "token"],
            grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const raw = await readBody(req);
        const form = parseForm(raw);
        lastGrant = form.grant_type ?? null;
        issued += 1;
        const access = `at-${issued}-${Math.random().toString(36).slice(2, 10)}`;
        const refresh = `rt-${issued}-${Math.random().toString(36).slice(2, 10)}`;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            access_token: access,
            token_type: "Bearer",
            expires_in: expiresIn,
            refresh_token: refresh,
            scope: grantedScope ?? form.scope ?? "",
            ...(subject === null ? {} : { sub: subject }),
          }),
        );
        return;
      }
      if (url.pathname === "/authorize" && req.method === "GET") {
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const u = new URL(redirect);
        u.searchParams.set("code", `code-${Date.now()}`);
        u.searchParams.set("state", state);
        res.statusCode = 302;
        res.setHeader("location", u.toString());
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    } catch (err) {
      res.statusCode = 500;
      res.end(`err: ${(err as Error).message}`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    issuedCount: () => issued,
    lastGrantType: () => lastGrant,
    setExpiresIn: (n: number) => {
      expiresIn = n;
    },
    setGrantedScope: (scope: string | null) => {
      grantedScope = scope;
    },
    setSubject: (value: string | null) => {
      subject = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export function noop(_req: IncomingMessage, _res: ServerResponse): void {}
