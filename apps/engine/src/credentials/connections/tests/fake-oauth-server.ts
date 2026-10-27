import { createHash, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOAuthServer {
  baseUrl: string;
  requests: string[];
  clients: Map<
    string,
    { redirect_uris: string[]; client_name?: string; client_uri?: string; scope?: string }
  >;
  decision: "approve" | "deny";
  expiresIn: number;
  issueRefreshToken: boolean;
  descriptor: boolean;
  registration: boolean;
  redirectPackage: boolean;
  oversizePackage: boolean;
  refuseRefresh: boolean;
  refreshError?: string;
  beforeRefreshResponse?: () => Promise<void>;
  accessTokens: string[];
  close: () => Promise<void>;
}

interface IssuedCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  spent: boolean;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export async function startFakeOAuthServer(
  options: { scopes?: string[]; name?: string; refreshRequiresOfflineAccess?: boolean } = {},
): Promise<FakeOAuthServer> {
  const scopes = options.scopes ?? ["read", "write", "admin"];
  const codes = new Map<string, IssuedCode>();
  const refreshTokens = new Map<string, { client_id: string; scope: string }>();
  let counter = 0;
  const next = (prefix: string) => `${prefix}-${++counter}`;

  const state: FakeOAuthServer = {
    baseUrl: "",
    requests: [],
    clients: new Map(),
    decision: "approve",
    expiresIn: 3600,
    issueRefreshToken: true,
    descriptor: true,
    registration: true,
    redirectPackage: false,
    oversizePackage: false,
    refuseRefresh: false,
    accessTokens: [],
    close: async () => {},
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    state.requests.push(`${req.method} ${url.pathname}`);
    const base = state.baseUrl;

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(state.registration ? { registration_endpoint: `${base}/register` } : {}),
        scopes_supported: scopes,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/.well-known/service-descriptor.json") {
      if (!state.descriptor) return json(res, 404, { error: "not_found" });
      return json(res, 200, {
        name: options.name ?? "Probe Service",
        description: "A test bench that speaks OAuth 2.1",
        version: "0.0.1",
        links: [{ rel: "package", href: "../package.json" }],
      });
    }
    if (url.pathname === "/package.json") {
      if (state.redirectPackage) {
        res.statusCode = 302;
        res.setHeader("location", "https://other.example/package.json");
        return res.end();
      }
      if (state.oversizePackage) {
        res.setHeader("content-length", String(300 * 1024));
        return res.end(" ".repeat(300 * 1024));
      }
      return json(res, 200, {
        format: "subkit.package/v1",
        id: "com.subkit.support",
        version: "1.1.0",
        name: "SubKit Support",
        artifacts: { skill: { href: "skill.md", sha256: "a".repeat(64) } },
        scripts: [{ command: "must not be returned" }],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        redirect_uris?: string[];
        client_name?: string;
        client_uri?: string;
        token_endpoint_auth_method?: string;
        scope?: string;
      };
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
        return json(res, 400, { error: "invalid_redirect_uri" });
      }
      if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
        return json(res, 400, { error: "invalid_client_metadata" });
      }
      const client_id = next("client");
      state.clients.set(client_id, {
        redirect_uris: body.redirect_uris,
        ...(body.client_name ? { client_name: body.client_name } : {}),
        ...(body.client_uri ? { client_uri: body.client_uri } : {}),
        ...(body.scope !== undefined ? { scope: body.scope } : {}),
      });
      return json(res, 201, { client_id, redirect_uris: body.redirect_uris });
    }
    if (url.pathname === "/authorize" && req.method === "GET") {
      const q = url.searchParams;
      const client = state.clients.get(q.get("client_id") ?? "");
      const redirect = q.get("redirect_uri") ?? "";
      if (!client?.redirect_uris.includes(redirect)) {
        return json(res, 400, { error: "invalid_client" });
      }
      if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") {
        return json(res, 400, { error: "invalid_request" });
      }
      const back = new URL(redirect);
      if (q.get("state")) back.searchParams.set("state", q.get("state") ?? "");
      if (state.decision === "deny") {
        back.searchParams.set("error", "access_denied");
      } else {
        const code = next("code");
        codes.set(code, {
          client_id: q.get("client_id") ?? "",
          redirect_uri: redirect,
          code_challenge: q.get("code_challenge") ?? "",
          scope: q.get("scope") ?? "",
          spent: false,
        });
        back.searchParams.set("code", code);
      }
      res.statusCode = 302;
      res.setHeader("location", back.toString());
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get("grant_type");
      const client_id = form.get("client_id") ?? "";
      if (!state.clients.has(client_id)) return json(res, 401, { error: "invalid_client" });
      let scope = "";
      if (grant === "authorization_code") {
        const issued = codes.get(form.get("code") ?? "");
        if (!issued || issued.spent) return json(res, 400, { error: "invalid_grant" });
        if (issued.client_id !== client_id || issued.redirect_uri !== form.get("redirect_uri")) {
          return json(res, 400, { error: "invalid_grant" });
        }
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (challenge !== issued.code_challenge) return json(res, 400, { error: "invalid_grant" });
        issued.spent = true;
        scope = issued.scope;
      } else if (grant === "refresh_token") {
        if (state.refuseRefresh)
          return json(res, 400, { error: state.refreshError ?? "invalid_grant" });
        const known = refreshTokens.get(form.get("refresh_token") ?? "");
        if (!known || known.client_id !== client_id)
          return json(res, 400, { error: "invalid_grant" });
        refreshTokens.delete(form.get("refresh_token") ?? "");
        scope = known.scope;
      } else {
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      const access_token = next("access");
      state.accessTokens.push(access_token);
      const body: Record<string, unknown> = {
        access_token,
        token_type: "Bearer",
        expires_in: state.expiresIn,
        scope,
      };
      const offline = scope.split(/\s+/).includes("offline_access");
      if (state.issueRefreshToken && (!options.refreshRequiresOfflineAccess || offline)) {
        const refresh_token = next("refresh");
        refreshTokens.set(refresh_token, { client_id, scope });
        body.refresh_token = refresh_token;
      }
      if (grant === "refresh_token") await state.beforeRefreshResponse?.();
      return json(res, 200, body);
    }
    if (url.pathname === "/api/whoami" && req.method === "GET") {
      const auth = req.headers.authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (!state.accessTokens.includes(token)) return json(res, 401, { error: "invalid_token" });
      return json(res, 200, { ok: true, token });
    }
    json(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve) =>
    server.listen(randomInt(20_000, 60_000), "127.0.0.1", () => resolve()),
  );
  const addr = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${addr.port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
