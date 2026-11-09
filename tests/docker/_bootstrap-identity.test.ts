import { describe, expect, test } from "bun:test";
import { resolveBootstrapIdentity } from "./_bootstrap-identity.ts";

const baseUrl = "http://engine.test";
const key = "wf_live_test";
const tenantId = "7d3b96bc-91f2-4e5e-a748-dac7d4bbfb50";

describe("resolveBootstrapIdentity", () => {
  test("returns the authenticated tenant identity", async () => {
    let requestUrl: string | URL | undefined;
    let request: RequestInit | undefined;
    const identity = await resolveBootstrapIdentity(baseUrl, key, async (_input, init) => {
      requestUrl = _input;
      request = init;
      return Response.json({ tenant_id: tenantId, tenant_slug: "customer-a" });
    });

    expect(requestUrl).toBe(`${baseUrl}/v1/identity/whoami`);
    expect(request?.headers).toEqual({ Authorization: `Bearer ${key}` });
    expect(identity).toEqual({ tenantId, tenantSlug: "customer-a" });
  });

  test("rejects an unauthorized API key", async () => {
    await expect(
      resolveBootstrapIdentity(baseUrl, key, async () => new Response(null, { status: 401 })),
    ).rejects.toThrow("GET /v1/identity/whoami failed: 401");
  });

  test.each([
    { tenant_id: "not-a-uuid", tenant_slug: "customer-a" },
    { tenant_id: tenantId, tenant_slug: "" },
    { tenant_id: tenantId, tenant_slug: "   " },
    { tenant_id: tenantId, tenant_slug: null },
  ])("rejects a malformed tenant identity", async (body) => {
    await expect(
      resolveBootstrapIdentity(baseUrl, key, async () => Response.json(body)),
    ).rejects.toThrow("GET /v1/identity/whoami returned an invalid tenant identity");
  });
});
