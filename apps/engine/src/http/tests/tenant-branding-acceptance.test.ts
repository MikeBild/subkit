import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { auditLog } from "../../db/schema/audit.ts";
import { apiKeys, systemAccounts } from "../../db/schema/index.ts";
import { tenantBranding } from "../../db/schema/tenant-branding.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
  type SecondaryTenant,
} from "./setup.ts";

let ctx: HttpTestServer;
let secondary: SecondaryTenant;
let ownerHeaders: Record<string, string>;
let logoBase64: string;
let scopedWriterKey: string;
let insufficientScopeKey: string;
let botLimitedKey: string;
let botWriterKey: string;

beforeAll(async () => {
  ctx = await createHttpTestServer("tenant-branding-acceptance");
  secondary = await createSecondaryTenant(ctx, "tenant-branding-acceptance");
  ownerHeaders = await browserSessionHeaders(ctx, ctx.userId);
  scopedWriterKey = "wf_live_aaaaaaaaaaaaaaaaaaaaaaaa";
  insufficientScopeKey = "wf_live_bbbbbbbbbbbbbbbbbbbbbbbb";
  botLimitedKey = "wf_live_cccccccccccccccccccccccc";
  botWriterKey = "wf_live_dddddddddddddddddddddddd";
  await ctx.db
    .update(systemAccounts)
    .set({ role_id: await builtinRoleId(ctx.db, "admin") })
    .where(eq(systemAccounts.id, ctx.systemAccountId));
  await ctx.db.insert(apiKeys).values([
    {
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      prefix: scopedWriterKey.slice(0, 12),
      token_sha256: createHash("sha256").update(scopedWriterKey).digest("hex"),
      scopes: ["settings:write", "identity:write"],
    },
    {
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      prefix: insufficientScopeKey.slice(0, 12),
      token_sha256: createHash("sha256").update(insufficientScopeKey).digest("hex"),
      scopes: ["settings:write"],
    },
    {
      tenant_id: ctx.tenantId,
      system_account_id: ctx.systemAccountId,
      prefix: botLimitedKey.slice(0, 12),
      token_sha256: createHash("sha256").update(botLimitedKey).digest("hex"),
      scopes: ["settings:write"],
    },
    {
      tenant_id: ctx.tenantId,
      system_account_id: ctx.systemAccountId,
      prefix: botWriterKey.slice(0, 12),
      token_sha256: createHash("sha256").update(botWriterKey).digest("hex"),
      scopes: ["settings:write", "identity:write"],
    },
  ]);
  logoBase64 = (
    await sharp({ create: { width: 2, height: 2, channels: 4, background: "#2563eb" } })
      .png()
      .toBuffer()
  ).toString("base64");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function request(
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = ownerHeaders,
): Promise<Response> {
  return await fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
}

function apiKeyHeaders(key = ctx.apiKey): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

function update(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    revision,
    display_name: "Acme Research",
    subtitle: "Governed work",
    palette: "indigo",
    logos: {
      light: { operation: "keep" },
      dark: { operation: "keep" },
    },
    ...overrides,
  };
}

describe("tenant branding HTTP acceptance", () => {
  test("returns identical initial metadata to a browser session and an API key", async () => {
    const expected = {
      configured: false,
      revision: 0,
      display_name: null,
      subtitle: null,
      palette: null,
      logos: { light: false, dark: false },
      logo_urls: { light: null, dark: null },
    };
    const [browser, api] = await Promise.all([
      request("/v1/tenant/branding"),
      request("/v1/tenant/branding", {}, apiKeyHeaders()),
    ]);
    expect(browser.status).toBe(200);
    expect(api.status).toBe(200);
    expect(await browser.json()).toEqual(expected);
    expect(await api.json()).toEqual(expected);
  });

  test("an API key writes metadata and logos that the browser reads identically", async () => {
    const saved = await request(
      "/v1/tenant/branding",
      {
        method: "PUT",
        body: JSON.stringify(
          update(0, {
            logos: {
              light: {
                operation: "replace",
                mime_type: "image/png",
                content_base64: logoBase64,
              },
              dark: { operation: "keep" },
            },
          }),
        ),
      },
      apiKeyHeaders(scopedWriterKey),
    );
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as {
      revision: number;
      logos: { light: boolean; dark: boolean };
      logo_urls: { light: string | null; dark: string | null };
    };
    expect(body).toMatchObject({ revision: 1, logos: { light: true, dark: false } });
    expect(body.logo_urls.light).toContain(`tenant_context=${ctx.tenantId}`);
    expect(body.logo_urls.light).toContain("revision=1");
    expect(body.logo_urls.dark).toContain(`tenant_context=${ctx.tenantId}`);

    const browser = await request("/v1/tenant/branding");
    expect(browser.status).toBe(200);
    expect(await browser.json()).toEqual(body);
  });

  test("isolates tenants and keeps logo bytes out of audit", async () => {
    const otherHeaders = await secondary.admin.sessionHeaders();
    const other = await request("/v1/tenant/branding", {}, otherHeaders);
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ configured: false, revision: 0 });

    const audit = await ctx.db
      .select({
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        metadata: auditLog.metadata,
        before: auditLog.before,
        after: auditLog.after,
      })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_type, "tenant_branding")),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: "user", actor_id: ctx.userId });
    expect(audit[0]?.metadata).toMatchObject({ source: "api" });
    expect(JSON.stringify(audit[0])).not.toContain(logoBase64);
  });

  test("allows any own-tenant principal to read but rejects member and insufficiently scoped writes", async () => {
    const memberHeaders = await secondary.member.sessionHeaders();
    const read = await request("/v1/tenant/branding", {}, memberHeaders);
    expect(read.status).toBe(200);

    const memberApiRead = await request(
      "/v1/tenant/branding",
      {},
      apiKeyHeaders(secondary.member.apiKey),
    );
    expect(memberApiRead.status).toBe(200);

    const memberWrite = await request(
      "/v1/tenant/branding",
      { method: "PUT", body: JSON.stringify(update(0)) },
      apiKeyHeaders(secondary.member.apiKey),
    );
    expect(memberWrite.status).toBe(403);

    const scopeWrite = await request(
      "/v1/tenant/branding",
      { method: "PUT", body: JSON.stringify(update(1)) },
      apiKeyHeaders(insufficientScopeKey),
    );
    expect(scopeWrite.status).toBe(403);

    const botRead = await request("/v1/tenant/branding", {}, apiKeyHeaders(botLimitedKey));
    expect(botRead.status).toBe(200);
    const botWrite = await request(
      "/v1/tenant/branding",
      { method: "PUT", body: JSON.stringify(update(1)) },
      apiKeyHeaders(botLimitedKey),
    );
    expect(botWrite.status).toBe(403);
  });

  test("requires browser CSRF before mutating branding", async () => {
    const headers = { ...ownerHeaders };
    delete headers["x-subkit-csrf"];
    const response = await request(
      "/v1/tenant/branding",
      { method: "PUT", body: JSON.stringify(update(1)) },
      headers,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "csrf_rejected" });
  });

  test("rejects stale and malformed writes without replacing current data", async () => {
    const stale = await request("/v1/tenant/branding", {
      method: "PUT",
      body: JSON.stringify(update(0, { display_name: "Stale" })),
    });
    expect(stale.status).toBe(409);

    const malformed = await request("/v1/tenant/branding", {
      method: "PUT",
      body: JSON.stringify({ ...update(1), unexpected: true }),
    });
    expect(malformed.status).toBe(400);

    const current = await request("/v1/tenant/branding");
    expect(await current.json()).toMatchObject({ revision: 1, display_name: "Acme Research" });
  });

  test("returns the same logo to an API key and scopes it to tenant context and exact revision", async () => {
    const current = (await (await request("/v1/tenant/branding")).json()) as {
      logo_urls: { light: string | null; dark: string | null };
    };
    if (!current.logo_urls.light || !current.logo_urls.dark) throw new Error("expected logo URLs");

    const [browserLogo, apiLogo] = await Promise.all([
      request(current.logo_urls.light),
      request(current.logo_urls.light, {}, apiKeyHeaders()),
    ]);
    expect(browserLogo.status).toBe(200);
    expect(apiLogo.status).toBe(200);
    expect(browserLogo.headers.get("content-type")).toBe("image/png");
    expect(apiLogo.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await browserLogo.arrayBuffer())).toEqual(
      Buffer.from(await apiLogo.arrayBuffer()),
    );

    const apiFallback = new URL(current.logo_urls.dark, ctx.baseUrl);
    apiFallback.searchParams.delete("tenant_context");
    const fallbackLogo = await request(
      `${apiFallback.pathname}${apiFallback.search}`,
      {},
      apiKeyHeaders(),
    );
    expect(fallbackLogo.status).toBe(200);
    const lightLogo = await request(current.logo_urls.light);
    expect(lightLogo.status).toBe(200);
    expect(Buffer.from(await fallbackLogo.arrayBuffer())).toEqual(
      Buffer.from(await lightLogo.arrayBuffer()),
    );

    const wrongTenant = new URL(current.logo_urls.light, ctx.baseUrl);
    wrongTenant.searchParams.set("tenant_context", secondary.tenantId);
    expect((await request(`${wrongTenant.pathname}${wrongTenant.search}`)).status).toBe(404);

    const wrongRevision = new URL(current.logo_urls.light, ctx.baseUrl);
    wrongRevision.searchParams.set("revision", "0");
    expect((await request(`${wrongRevision.pathname}${wrongRevision.search}`)).status).toBe(404);
  });

  test("an authorized bot API key resets branding, preserves the row revision, and prevents an ABA overwrite", async () => {
    const reset = await request(
      "/v1/tenant/branding",
      {
        method: "DELETE",
        body: JSON.stringify({ revision: 1 }),
      },
      apiKeyHeaders(botWriterKey),
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ configured: false, revision: 2 });

    const auditRows = await ctx.db
      .select({
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_type, "tenant_branding")),
      )
      .orderBy(auditLog.ts);
    const latestAudit = auditRows.at(-1);
    expect(auditRows[0]).toMatchObject({ actor_type: "user", actor_id: ctx.userId });
    expect(latestAudit).toMatchObject({
      actor_type: "system_account",
      actor_id: ctx.systemAccountId,
      metadata: { source: "api" },
    });

    const row = await ctx.db
      .select({ revision: tenantBranding.revision })
      .from(tenantBranding)
      .where(eq(tenantBranding.tenant_id, ctx.tenantId));
    expect(row).toEqual([{ revision: 2 }]);

    const stale = await request("/v1/tenant/branding", {
      method: "PUT",
      body: JSON.stringify(update(0)),
    });
    expect(stale.status).toBe(409);
  });

  test("caps a streamed request before JSON parsing when content length is absent", async () => {
    const body = JSON.stringify({ ...update(2), padding: "x".repeat(6 * 1024 * 1024) });
    const response = await fetch(`${ctx.baseUrl}/v1/tenant/branding`, {
      method: "PUT",
      headers: apiKeyHeaders(scopedWriterKey),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "request_too_large" });
  });

  test("admits exactly one concurrent first write", async () => {
    const racing = await createSecondaryTenant(ctx, "tenant-branding-race");
    const [firstHeaders, secondHeaders] = await Promise.all([
      racing.admin.sessionHeaders(),
      racing.admin.sessionHeaders(),
    ]);
    const [first, second] = await Promise.all([
      request(
        "/v1/tenant/branding",
        { method: "PUT", body: JSON.stringify(update(0, { display_name: "First" })) },
        firstHeaders,
      ),
      request(
        "/v1/tenant/branding",
        { method: "PUT", body: JSON.stringify(update(0, { display_name: "Second" })) },
        secondHeaders,
      ),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);

    const rows = await ctx.db
      .select({ revision: tenantBranding.revision })
      .from(tenantBranding)
      .where(eq(tenantBranding.tenant_id, racing.tenantId));
    expect(rows).toEqual([{ revision: 1 }]);
  });
});
