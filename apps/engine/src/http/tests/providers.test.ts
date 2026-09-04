import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { apiKeys, users } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer, loadAuthProvidersForTest } from "./setup.ts";

let ctx: HttpTestServer;

const apiKeyProvider = { protocol: "api_key" as const, id: "api-key", label: "SubKit API key" };

beforeEach(async () => {
  ctx = await createHttpTestServer("providers");
  await loadAuthProvidersForTest([apiKeyProvider], ctx.testDb.url);
});

afterEach(async () => {
  await ctx.cleanup();
});

describe("GET /v1/identity/providers", () => {
  test("answers an anonymous caller — the caller with no credential is the one who needs this", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      providers: { protocol: string; id: string; label: string }[];
    };
    expect(data.providers).toEqual([{ protocol: "api_key", id: "api-key", label: "API key" }]);
  });

  test("returns every configured adapter with only protocol-neutral connection metadata", async () => {
    await loadAuthProvidersForTest(
      [
        apiKeyProvider,
        {
          protocol: "oidc",
          id: "partner",
          label: "Partner",
          issuer_url: "https://partner.example.com",
          client_id: "subkit",
          scopes: "openid profile email",
          tenant_slug: "default",
        },
      ],
      ctx.testDb.url,
    );

    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      providers: {
        protocol: string;
        id: string;
        label: string;
      }[];
    };
    // The label is generic, per protocol. The operator typed "Partner", and an
    // operator's own wording can carry the name of a company — it is not
    // published to an anonymous caller.
    expect(data.providers).toEqual([
      { protocol: "oidc", id: "partner", label: "SSO" },
      { protocol: "api_key", id: "api-key", label: "API key" },
    ]);
    const body = JSON.stringify(data);
    expect(body).not.toContain("partner.example.com");
    expect(body).not.toContain("client_id");
    expect(body).not.toContain("openid profile email");
    expect(body).not.toContain("Partner");
    expect(body).not.toContain("SubKit API key");
  });

  test("says exactly the same thing to a signed-in caller", async () => {
    // Two different answers would turn this route into a probe for whether a
    // credential is valid. Byte-identical, deliberately.
    await loadAuthProvidersForTest(
      [
        apiKeyProvider,
        {
          protocol: "oidc",
          id: "partner",
          label: "Partner",
          issuer_url: "https://partner.example.com",
          client_id: "subkit",
          scopes: "openid profile email",
          tenant_slug: "default",
        },
      ],
      ctx.testDb.url,
    );

    const anonymous = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    const authenticated = await fetch(`${ctx.baseUrl}/v1/identity/providers`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(anonymous.status).toBe(200);
    expect(authenticated.status).toBe(200);
    expect(await anonymous.text()).toBe(await authenticated.text());
  });

  test("a principal without identity:read is answered too — there is nothing to withhold", async () => {
    const [user] = await ctx.db
      .insert(users)
      .values({ tenant_id: ctx.tenantId, email: "enduser-providers@test.local", role: "enduser" })
      .returning();
    expect(user).toBeDefined();
    const plaintext = `wf_live_${"x".repeat(32)}`;
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: user!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: createHash("sha256").update(plaintext).digest("hex"),
      scopes: ["*"],
    });

    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
  });
});
