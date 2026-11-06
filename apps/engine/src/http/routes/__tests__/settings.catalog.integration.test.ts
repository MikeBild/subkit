import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { apiKeys, tenants, users } from "../../../db/schema/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { authedFetch, det, nextSeq, server, setupSettingsRoutes } from "./settings-fixtures.ts";

setupSettingsRoutes();

describe("GET /v1/settings/catalog/models", () => {
  interface CatalogBody {
    currency: string;
    models: Array<{
      model: string;
      provider: string | null;
      display_name: string;
      price_source: string;
      input_per_mtok: number;
      badges: { recommended: boolean };
    }>;
  }

  async function memberKey(tenantId: string, scopes: string[]): Promise<string> {
    const seqTag = nextSeq();
    const [member] = await server.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: `catalog-${seqTag}@test.local`,
        role_id: await builtinRoleId(server.db, "member"),
      })
      .returning();
    const plaintext = `wf_live_${det(16)}`;
    await server.db.insert(apiKeys).values({
      tenant_id: tenantId,
      user_id: member!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: createHash("sha256").update(plaintext).digest("hex"),
      scopes,
    });
    return plaintext;
  }

  test("returns the named model catalog instead of an unknown setting path", async () => {
    const res = await authedFetch("/v1/settings/catalog/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogBody;
    expect(body.currency).toBe("USD");
    expect(body.models.find((m) => m.model === "gpt-4.1-mini")).toMatchObject({
      provider: "openai",
      display_name: "GPT-4.1 mini",
      price_source: "catalog",
      badges: { recommended: true },
    });
  });

  test("rejects a request without authentication", async () => {
    const res = await fetch(`${server.baseUrl}/v1/settings/catalog/models`);
    expect(res.status).toBe(401);
  });

  test("rejects a principal without settings:read", async () => {
    const key = await memberKey(server.tenantId, ["workflows:read"]);
    const res = await fetch(`${server.baseUrl}/v1/settings/catalog/models`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
  });

  test("another workspace's price override stays in that workspace", async () => {
    const seqTag = nextSeq();
    const [otherTenant] = await server.db
      .insert(tenants)
      .values({ slug: `catalog-${seqTag}`, display_name: "Catalog Tenant" })
      .returning();
    const put = await authedFetch(`/v1/settings/tokens.prices?tenant=${otherTenant!.id}`, {
      method: "PUT",
      body: JSON.stringify({
        value: [{ model: "gpt-4.1-mini", input_per_mtok: 0.01, output_per_mtok: 0.02 }],
      }),
    });
    expect(put.status).toBe(200);

    const priceOf = async (res: Response) => {
      expect(res.status).toBe(200);
      const body = (await res.json()) as CatalogBody;
      return body.models.find((m) => m.model === "gpt-4.1-mini");
    };
    expect(
      await priceOf(await authedFetch(`/v1/settings/catalog/models?tenant=${otherTenant!.id}`)),
    ).toMatchObject({ price_source: "override", input_per_mtok: 0.01 });
    expect(
      await priceOf(await authedFetch(`/v1/settings/catalog/models?tenant=${server.tenantId}`)),
    ).toMatchObject({ price_source: "catalog", input_per_mtok: 0.4 });
    expect(await priceOf(await authedFetch("/v1/settings/catalog/models"))).toMatchObject({
      price_source: "catalog",
    });

    const otherMember = await memberKey(otherTenant!.id, ["*"]);
    const ownView = await fetch(`${server.baseUrl}/v1/settings/catalog/models`, {
      headers: { authorization: `Bearer ${otherMember}` },
    });
    expect(await priceOf(ownView)).toMatchObject({ price_source: "override" });
    const crossRead = await fetch(
      `${server.baseUrl}/v1/settings/catalog/models?tenant=${server.tenantId}`,
      { headers: { authorization: `Bearer ${otherMember}` } },
    );
    expect(crossRead.status).toBe(403);
  });

  test("the catalog carries no secret references or key material", async () => {
    await authedFetch(`/v1/settings/llm.api_key?tenant=${server.tenantId}`, {
      method: "PUT",
      body: JSON.stringify({ value: "catalog-leak-probe-key" }),
    });
    const res = await authedFetch(`/v1/settings/catalog/models?tenant=${server.tenantId}`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("secret://");
    expect(text).not.toContain("catalog-leak-probe-key");
    expect(text).not.toContain("api_key");
  });
});
