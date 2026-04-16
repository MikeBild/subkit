// Login OIDC device-flow exercise.
//
// Stand up a tiny in-process HTTP server that pretends to be both an
// OIDC issuer (discovery + device authorization + token endpoints) and
// a subkit engine (the /v1/identity/sessions/oidc exchange). Drive the
// CLI's runDeviceFlow helper against it and assert we get an api_key
// back. This uses real openid-client v6 + jose so any breaking change
// in either lib shows up here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as jose from "jose";
import { runDeviceFlow } from "../commands/login.ts";

interface MockIdp {
  baseUrl: string;
  close: () => Promise<void>;
  /** The api_key the engine half hands out on successful exchange. */
  issuedKey: () => string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function startMockIdp(): Promise<MockIdp> {
  // Generate a single signing key for the mock IdP. We export both as
  // a JWK (for the JWKS endpoint) and use the private key to sign
  // id_tokens.
  const { privateKey, publicKey } = await jose.generateKeyPair("RS256", { extractable: true });
  const publicJwk = await jose.exportJWK(publicKey);
  publicJwk.kid = "mock-key-1";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const ISSUED_API_KEY = "wf_live_mock_oidc_test_key";
  let baseUrl = "";
  const SUB = "mock|alice";
  const EMAIL = "alice@mock.test";

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", baseUrl || "http://localhost");
    try {
      if (url.pathname === "/.well-known/openid-configuration") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            device_authorization_endpoint: `${baseUrl}/device_authorization`,
            token_endpoint: `${baseUrl}/token`,
            jwks_uri: `${baseUrl}/jwks`,
            response_types_supported: ["code"],
            grant_types_supported: [
              "authorization_code",
              "urn:ietf:params:oauth:grant-type:device_code",
            ],
            id_token_signing_alg_values_supported: ["RS256"],
            subject_types_supported: ["public"],
          }),
        );
        return;
      }
      if (url.pathname === "/jwks") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      if (url.pathname === "/device_authorization" && req.method === "POST") {
        // openid-client posts client_id + scope here.
        await readBody(req);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            device_code: "device-code-xyz",
            user_code: "ABCD-1234",
            verification_uri: `${baseUrl}/activate`,
            verification_uri_complete: `${baseUrl}/activate?user_code=ABCD-1234`,
            expires_in: 600,
            interval: 1,
          }),
        );
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        // First (and only) poll succeeds — mint an id_token signed by
        // our private key.
        await readBody(req);
        const id_token = await new jose.SignJWT({
          email: EMAIL,
          email_verified: true,
        })
          .setProtectedHeader({ alg: "RS256", kid: "mock-key-1" })
          .setSubject(SUB)
          .setIssuer(baseUrl)
          .setAudience("subkit-cli")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            access_token: "at-mock",
            token_type: "Bearer",
            expires_in: 3600,
            id_token,
            scope: "openid profile email offline_access",
          }),
        );
        return;
      }
      if (url.pathname === "/v1/identity/sessions/oidc" && req.method === "POST") {
        // Engine half — verify the body has an id_token + issuer and
        // return a fake api_key. (The real engine route is exercised
        // separately; here we only need to confirm the CLI hands the
        // tokens off correctly.)
        const raw = await readBody(req);
        const body = JSON.parse(raw);
        if (typeof body.id_token !== "string" || typeof body.issuer !== "string") {
          res.statusCode = 400;
          res.end("missing fields");
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            api_key: ISSUED_API_KEY,
            user_id: "00000000-0000-0000-0000-000000000111",
            tenant_id: "00000000-0000-0000-0000-000000000222",
            sub: SUB,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    } catch (err) {
      res.statusCode = 500;
      res.end((err as Error).message);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    issuedKey: () => ISSUED_API_KEY,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let idp: MockIdp;
beforeAll(async () => {
  idp = await startMockIdp();
});
afterAll(async () => {
  await idp.close();
});

describe("subkit login OIDC device flow", () => {
  test("runDeviceFlow exchanges id_token for an engine api_key", async () => {
    const result = await runDeviceFlow({
      issuer_url: idp.baseUrl,
      client_id: "subkit-cli",
      engine_url: idp.baseUrl,
      quiet: true,
    });
    expect(result.api_key).toBe(idp.issuedKey());
    expect(result.sub).toBe("mock|alice");
    expect(result.user_id).toBeTruthy();
  }, 20_000);
});
