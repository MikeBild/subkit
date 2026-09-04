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
  test("returns the configured API-key adapter to an identity reader", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      providers: { protocol: string; id: string; label: string }[];
    };
    expect(data.providers).toEqual([
      { protocol: "api_key", id: "api-key", label: "SubKit API key" },
    ]);
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

    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      providers: {
        protocol: string;
        id: string;
        label: string;
      }[];
    };
    expect(data.providers).toEqual([
      {
        protocol: "oidc",
        id: "partner",
        label: "Partner",
      },
      { protocol: "api_key", id: "api-key", label: "SubKit API key" },
    ]);
    expect(JSON.stringify(data)).not.toContain("partner.example.com");
    expect(JSON.stringify(data)).not.toContain("client_id");
  });

  test("rejects anonymous requests", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    expect(res.status).toBe(401);
  });

  test("rejects an authenticated principal without identity:read", async () => {
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
    expect(res.status).toBe(403);
  });
});
