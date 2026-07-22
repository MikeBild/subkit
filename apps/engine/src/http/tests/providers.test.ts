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
        issuer?: string;
      }[];
    };
    expect(data.providers).toEqual([
      {
        protocol: "oidc",
        id: "partner",
        label: "SSO",
        issuer: "https://partner.example.com",
      },
      { protocol: "api_key", id: "api-key", label: "API key" },
    ]);
  });

  test("does not require authentication", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    expect(res.status).toBe(200);
  });
});
