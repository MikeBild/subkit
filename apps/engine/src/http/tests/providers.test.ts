import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  test("returns the canonical API-key adapter by default", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      providers: { protocol: string; id: string; label: string }[];
    };
    expect(data.providers).toEqual([apiKeyProvider]);
  });

  test("returns every configured adapter without provider-specific fields", async () => {
    await loadAuthProvidersForTest(
      [
        apiKeyProvider,
        {
          protocol: "token_bridge",
          id: "workforce",
          label: "Workforce",
          login_url: "https://login.example.com/subkit",
          issuer_url: "https://issuer.example.com",
          audience: "subkit",
          jwks_url: "https://issuer.example.com/jwks",
          tenant_slug: "default",
          subject_claim: "sub",
          email_claim: "email",
          email_verified_claim: "email_verified",
        },
        {
          protocol: "oidc",
          id: "partner",
          label: "Partner",
          issuer_url: "https://partner.example.com",
          client_id: "subkit",
          client_secret: "",
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
        login_url?: string;
        issuer?: string;
      }[];
    };
    expect(data.providers.map((provider) => provider.protocol)).toEqual([
      "api_key",
      "token_bridge",
      "oidc",
    ]);
    expect(data.providers[1]?.login_url).toBe("https://login.example.com/subkit");
    expect(data.providers[2]?.issuer).toBe("https://partner.example.com");
  });

  test("does not require authentication", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    expect(res.status).toBe(200);
  });
});
