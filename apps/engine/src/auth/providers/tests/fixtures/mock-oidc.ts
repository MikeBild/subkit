import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

export interface MockOidcHandle {
  url: string;
  stop: () => Promise<void>;
  issueFor: (
    claims: Record<string, unknown>,
    params: { state: string; redirect_uri: string },
  ) => { code: string; callbackUrl: string };
  signIdToken: (
    claims: Record<string, unknown>,
    opts?: { issuer?: string; audience?: string; expiresInSec?: number },
  ) => Promise<string>;
}

type KeyPairLike = Awaited<ReturnType<typeof generateKeyPair>>;

interface PendingAuth {
  code: string;
  claims: Record<string, unknown>;
}

export async function startMockOidc(): Promise<MockOidcHandle> {
  const keys: KeyPairLike = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = await exportJWK(keys.publicKey);
  jwk.use = "sig";
  jwk.alg = "RS256";
  jwk.kid = "mock-oidc-key-1";

  let pending: PendingAuth | null = null;
  let lastClaims: Record<string, unknown> | null = null;
  let lastAuthorizeNonce: string | null = null;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const issuer = `http://${req.headers.host ?? "127.0.0.1"}`;

      if (url.pathname === "/.well-known/openid-configuration" && req.method === "GET") {
        const body = {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
          code_challenge_methods_supported: ["S256"],
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }

      if (url.pathname === "/jwks" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }

      if (url.pathname === "/authorize" && req.method === "GET") {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const nonce = url.searchParams.get("nonce");
        if (nonce) lastAuthorizeNonce = nonce;
        const code = pending?.code ?? `code_${Math.random().toString(36).slice(2)}`;
        const dest = new URL(redirectUri);
        dest.searchParams.set("code", code);
        if (state) dest.searchParams.set("state", state);
        res.writeHead(302, { location: dest.toString() });
        res.end();
        return;
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const body = await readFormBody(req);
        const code = body.get("code") ?? "";
        if (!pending || pending.code !== code) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const claims = { ...pending.claims };
        if (lastAuthorizeNonce && claims.nonce === undefined) {
          claims.nonce = lastAuthorizeNonce;
        }
        const clientId = body.get("client_id") ?? "mock-client";
        const nowSec = Math.floor(Date.now() / 1000);
        const id_token = await new SignJWT(claims)
          .setProtectedHeader({ alg: "RS256", kid: jwk.kid ?? "mock-oidc-key-1" })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setSubject(String(claims.sub ?? "mock-sub"))
          .setIssuedAt(nowSec)
          .setExpirationTime(nowSec + 600)
          .sign(keys.privateKey);
        lastClaims = claims;
        pending = null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "mock-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            id_token,
          }),
        );
        return;
      }

      if (url.pathname === "/userinfo" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(lastClaims ?? { sub: "mock-sub" }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: "mock_oidc_failure", detail: (err as Error).message ?? "err" }),
      );
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    issueFor: (claims, params) => {
      const code = `code_${Math.random().toString(36).slice(2)}`;
      pending = { code, claims };
      const dest = new URL(params.redirect_uri);
      dest.searchParams.set("code", code);
      dest.searchParams.set("state", params.state);
      return { code, callbackUrl: dest.toString() };
    },
    signIdToken: async (claims, opts = {}) => {
      const nowSec = Math.floor(Date.now() / 1000);
      return await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid ?? "mock-oidc-key-1" })
        .setIssuer(opts.issuer ?? url)
        .setAudience(opts.audience ?? "mock-client")
        .setSubject(String(claims.sub ?? "mock-sub"))
        .setIssuedAt(nowSec)
        .setExpirationTime(nowSec + (opts.expiresInSec ?? 600))
        .sign(keys.privateKey);
    },
  };
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return new URLSearchParams(body);
}
