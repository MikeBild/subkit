import { describe, expect, test } from "bun:test";
import type { EngineError } from "@cli-core/errors.ts";
import { EngineClient, type TenantBranding } from "../engine-client.ts";

const branding: TenantBranding = {
  configured: true,
  revision: 7,
  display_name: "Acme",
  subtitle: null,
  palette: "teal",
  logos: { light: true, dark: false },
  logo_urls: { light: "/logo", dark: "/logo" },
};

describe("tenant branding EngineClient parity", () => {
  test("maps get, update and reset through the tenant-scoped API", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new EngineClient({
      engine_url: "https://engine.test/",
      api_key: "key",
      tenant: "tenant-a",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json(branding);
      },
    });
    expect(await client.getTenantBranding()).toEqual(branding);
    await client.updateTenantBranding({
      revision: 7,
      display_name: "Acme",
      subtitle: null,
      palette: "teal",
      logos: { light: { operation: "keep" }, dark: { operation: "remove" } },
    });
    await client.resetTenantBranding(8);
    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
      ["https://engine.test/v1/tenant/branding", "GET"],
      ["https://engine.test/v1/tenant/branding", "PUT"],
      ["https://engine.test/v1/tenant/branding", "DELETE"],
    ]);
    expect(new Headers(calls[1]?.init?.headers).get("x-subkit-tenant")).toBe("tenant-a");
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      revision: 7,
      logos: { dark: { operation: "remove" } },
    });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ revision: 8 });
  });

  test("downloads PNG bytes and forwards optional tenant context", async () => {
    let url = "";
    const client = new EngineClient({
      engine_url: "https://engine.test",
      api_key: "key",
      tenant: "tenant-a",
      fetchImpl: async (input) => {
        url = String(input);
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" },
        });
      },
    });
    expect(await client.getTenantBrandingLogo({ theme: "dark", revision: 7 })).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
    expect(url).toBe(
      "https://engine.test/v1/tenant/branding/logo?theme=dark&tenant_context=tenant-a&revision=7",
    );
  });

  test("preserves permission and stale-revision API errors", async () => {
    const denied = new EngineClient({
      engine_url: "https://engine.test",
      api_key: "key",
      fetchImpl: async () => Response.json({ code: "forbidden" }, { status: 403 }),
    });
    const stale = new EngineClient({
      engine_url: "https://engine.test",
      api_key: "key",
      fetchImpl: async () => Response.json({ code: "revision_conflict" }, { status: 409 }),
    });
    await expect(denied.getTenantBranding()).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<EngineError>);
    await expect(stale.resetTenantBranding(2)).rejects.toMatchObject({
      status: 409,
    } satisfies Partial<EngineError>);
  });
});
