import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";
import { and, desc, eq } from "drizzle-orm";
import * as jose from "jose";
import { auditLog } from "../../db/schema/index.ts";
import { loadAuthProvidersForTest } from "../../http/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

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

  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-06-audit");

    await seedTenant(ctx.db, { slug: "default", display_name: "default" });

    const kp = await jose.generateKeyPair("RS256", { extractable: true });
    const jwk = await jose.exportJWK(kp.publicKey);
    jwk.alg = "RS256";
    jwk.use = "sig";
    jwk.kid = "sk-test-1";
    jwksJson = JSON.stringify({ keys: [jwk] });

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

    await loadAuthProvidersForTest(
      [
        { protocol: "api_key", id: "api-key", label: "SubKit API key" },
        {
          protocol: "oidc",
          id: "journey-identity",
          label: "Journey identity",
          issuer_url: idpUrl,
          client_id: "subkit-cli",
          scopes: "openid profile email",
          tenant_slug: "default",
        },
      ],
      ctx.testDb.url,
    );
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    if (idpServer) {
      await new Promise<void>((resolve) => idpServer.close(() => resolve()));
    }
    if (ctx) {
      await ctx.cleanup();
    }
  }, JOURNEY_HOOK_TIMEOUT);

  test("POST /v1/identity/sessions with sk-cli user-agent emits SK_CLI_LOGIN", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "sk-cli/0.0.1",
      },
      body: JSON.stringify({ provider_id: "journey-identity", identity_token: idToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principal_id: string; api_key: string };
    expect(body.api_key.startsWith("wf_")).toBe(true);

    const loggedIn = await auditRowsByAction("user.logged_in", body.principal_id);
    expect(loggedIn.length).toBeGreaterThanOrEqual(1);

    const skCliLogin = await auditRowsByAction("sk_cli.login", body.principal_id);
    expect(skCliLogin.length).toBe(1);
    const metadata = skCliLogin[0]?.metadata as { user_agent?: string };
    expect(metadata?.user_agent).toBe("sk-cli/0.0.1");
  });

  test("same endpoint without sk-cli user-agent does NOT emit SK_CLI_LOGIN", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "subkit/0.0.1" },
      body: JSON.stringify({ provider_id: "journey-identity", identity_token: idToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principal_id: string };
    const skCliLogin = await auditRowsByAction("sk_cli.login", body.principal_id);
    expect(skCliLogin.length).toBe(1);
  });
});
