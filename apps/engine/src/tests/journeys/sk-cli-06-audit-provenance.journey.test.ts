// User story: As a SOC 2 reviewer, I can distinguish sk-cli-originated
// logins from compatibility-alias logins by querying the audit log for
// `sk_cli.login` rows. The engine tags OIDC exchanges when the
// `user-agent: sk-cli/*` header is present on the request.
//
// This test stands up a mock OIDC IdP, drives the engine's
// `POST /v1/identity/sessions/oidc` endpoint with a sk-cli user-agent
// header, and asserts the `SK_CLI_LOGIN` audit action lands on top of
// the standard `USER_LOGGED_IN` row.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";
import { and, desc, eq } from "drizzle-orm";
import * as jose from "jose";
import { auditLog, tenants } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;
let idpServer: HttpServer;
let idpPort = 0;
let idToken = "";
let idpUrl = "";

async function auditRowsByAction(
  action: string,
  actorId: string,
): Promise<Array<{ action: string; actor_id: string | null; metadata: unknown }>> {
  const rows = await ctx.db
    .select({ action: auditLog.action, actor_id: auditLog.actor_id, metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.actor_id, actorId)))
    .orderBy(desc(auditLog.ts))
    .limit(50);
  return rows;
}

describe("journey: sk-cli audit provenance", () => {
  let jwksJson = "";

  // 30s — RSA keypair generation + journey ctx + IDP server can blow
  // past the 5s default on slower CI runners.
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-06-audit");

    // The sessions-oidc route hard-codes a lookup for slug=`default`.
    // Seed that tenant row so the journey fixture's random slug does
    // not break the test. We reuse the existing journey-created
    // admin tenant by renaming it.
    await ctx.db.insert(tenants).values({ slug: "default", display_name: "default" });

    // Mint an RS256 key pair (jose's helper returns extractable keys)
    // and build a matching JWKS so the engine can verify the id_token
    // we hand it below.
    const kp = await jose.generateKeyPair("RS256", { extractable: true });
    const jwk = await jose.exportJWK(kp.publicKey);
    jwk.alg = "RS256";
    jwk.use = "sig";
    jwk.kid = "sk-test-1";
    jwksJson = JSON.stringify({ keys: [jwk] });

    // Tiny mock OIDC IdP that serves discovery + jwks.
    idpServer = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: idpUrl,
            jwks_uri: `${idpUrl}/jwks`,
            authorization_endpoint: `${idpUrl}/auth`,
            token_endpoint: `${idpUrl}/token`,
          }),
        );
        return;
      }
      if (req.url === "/jwks") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jwksJson);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      idpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = idpServer.address();
    if (addr && typeof addr === "object") {
      idpPort = addr.port;
    }
    idpUrl = `http://127.0.0.1:${idpPort}`;

    // Sign an id_token for a fresh subject using the private half of
    // the key pair above.
    idToken = await new jose.SignJWT({
      sub: "sk-cli-06-subject",
      email: "sk-cli-06@test.local",
    })
      .setProtectedHeader({ alg: "RS256", kid: "sk-test-1" })
      .setIssuer(idpUrl)
      .setAudience("subkit-cli")
      .setExpirationTime("5m")
      .setIssuedAt()
      .sign(kp.privateKey);
  }, 30_000);

  afterAll(async () => {
    if (idpServer) {
      await new Promise<void>((resolve) => idpServer.close(() => resolve()));
    }
    if (ctx) {
      await ctx.cleanup();
    }
  });

  test("POST /v1/identity/sessions/oidc with sk-cli user-agent emits SK_CLI_LOGIN", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/sessions/oidc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "sk-cli/0.0.1",
      },
      body: JSON.stringify({ id_token: idToken, issuer: idpUrl }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string; api_key: string };
    expect(body.api_key.startsWith("wf_")).toBe(true);

    const loggedIn = await auditRowsByAction("user.logged_in", body.user_id);
    expect(loggedIn.length).toBeGreaterThanOrEqual(1);

    const skCliLogin = await auditRowsByAction("sk_cli.login", body.user_id);
    expect(skCliLogin.length).toBe(1);
    const metadata = skCliLogin[0]?.metadata as { user_agent?: string };
    expect(metadata?.user_agent).toBe("sk-cli/0.0.1");
  });

  test("same endpoint without sk-cli user-agent does NOT emit SK_CLI_LOGIN", async () => {
    // Reuse the id_token minted in beforeAll. The engine upserts on
    // `sub`, so this call resolves to the same user row as the first
    // test. That lets us assert the sk_cli.login count stays at 1:
    // only the first (sk-cli-tagged) login minted a row.
    const res = await fetch(`${ctx.baseUrl}/v1/identity/sessions/oidc`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "subkit/0.0.1" },
      body: JSON.stringify({ id_token: idToken, issuer: idpUrl }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string };
    const skCliLogin = await auditRowsByAction("sk_cli.login", body.user_id);
    expect(skCliLogin.length).toBe(1);
  });
});
