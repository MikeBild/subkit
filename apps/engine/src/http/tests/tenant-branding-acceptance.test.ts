import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { auditLog } from "../../db/schema/audit.ts";
import { tenantBranding } from "../../db/schema/tenant-branding.ts";
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

beforeAll(async () => {
  ctx = await createHttpTestServer("tenant-branding-acceptance");
  secondary = await createSecondaryTenant(ctx, "tenant-branding-acceptance");
  ownerHeaders = await browserSessionHeaders(ctx, ctx.userId);
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
  test("defaults are readable only through a browser session", async () => {
    const missing = await fetch(`${ctx.baseUrl}/v1/tenant/branding`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: "browser_session_required" });

    const response = await request("/v1/tenant/branding");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: false,
      revision: 0,
      display_name: null,
      subtitle: null,
      palette: null,
      logos: { light: false, dark: false },
      logo_urls: { light: null, dark: null },
    });
  });

  test("uses the current revision, isolates tenants, and keeps logo bytes out of audit", async () => {
    const saved = await request("/v1/tenant/branding", {
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
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as {
      revision: number;
      logos: { light: boolean; dark: boolean };
      logo_urls: { light: string | null; dark: string | null };
    };
    expect(body).toMatchObject({ revision: 1, logos: { light: true, dark: false } });
    expect(body.logo_urls.light).toContain(`tenant_context=${ctx.tenantId}`);
    expect(body.logo_urls.light).toContain("revision=1");

    const otherHeaders = await secondary.admin.sessionHeaders();
    const other = await request("/v1/tenant/branding", {}, otherHeaders);
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ configured: false, revision: 0 });

    const audit = await ctx.db
      .select({ metadata: auditLog.metadata, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_type, "tenant_branding")),
      );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain(logoBase64);
  });

  test("allows members to read but rejects their writes even though members have settings write", async () => {
    const memberHeaders = await secondary.member.sessionHeaders();
    const read = await request("/v1/tenant/branding", {}, memberHeaders);
    expect(read.status).toBe(200);

    const write = await request(
      "/v1/tenant/branding",
      { method: "PUT", body: JSON.stringify(update(0)) },
      memberHeaders,
    );
    expect(write.status).toBe(403);
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

  test("scopes logo reads to tenant context and the exact revision", async () => {
    const current = (await (await request("/v1/tenant/branding")).json()) as {
      logo_urls: { light: string | null };
    };
    if (!current.logo_urls.light) throw new Error("expected light logo URL");

    const logo = await request(current.logo_urls.light);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(logo.headers.get("cache-control")).toBe("private, no-store");

    const wrongTenant = new URL(current.logo_urls.light, ctx.baseUrl);
    wrongTenant.searchParams.set("tenant_context", secondary.tenantId);
    expect((await request(`${wrongTenant.pathname}${wrongTenant.search}`)).status).toBe(404);

    const wrongRevision = new URL(current.logo_urls.light, ctx.baseUrl);
    wrongRevision.searchParams.set("revision", "0");
    expect((await request(`${wrongRevision.pathname}${wrongRevision.search}`)).status).toBe(404);
  });

  test("reset preserves the row revision and prevents an ABA overwrite", async () => {
    const reset = await request("/v1/tenant/branding", {
      method: "DELETE",
      body: JSON.stringify({ revision: 1 }),
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ configured: false, revision: 2 });

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
      headers: ownerHeaders,
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
