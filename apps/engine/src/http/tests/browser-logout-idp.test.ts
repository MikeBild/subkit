import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browserSessionCookie, signBrowserSession } from "../../auth/browser-session.ts";
import {
  type MockOidcHandle,
  startMockOidc,
} from "../../auth/providers/tests/fixtures/mock-oidc.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
  loadAuthProvidersForTest,
} from "./setup.ts";

let ctx: HttpTestServer;
let idp: MockOidcHandle;

beforeAll(async () => {
  ctx = await createHttpTestServer("browser-logout-idp");
  idp = await startMockOidc();
  await loadAuthProvidersForTest(
    [
      {
        protocol: "oidc",
        id: "company",
        label: "Company",
        issuer_url: idp.url,
        client_id: "subkit-cockpit",
        scopes: "openid profile email",
        tenant_slug: "default",
      },
      { protocol: "api_key", id: "api-key", label: "API key" },
    ],
    ctx.testDb.url,
  );
});

afterAll(async () => {
  await idp.stop();
  await ctx.cleanup();
});

async function headersFor(loginProvider?: string): Promise<Record<string, string>> {
  const headers = await browserSessionHeaders(ctx, ctx.userId);
  if (!loginProvider) return headers;
  const raw = decodeURIComponent((headers.cookie ?? "").split("=")[1] ?? "");
  const claims = JSON.parse(Buffer.from(raw.split(".")[1] ?? "", "base64url").toString());
  return {
    ...headers,
    cookie: browserSessionCookie(
      await signBrowserSession({
        session_id: claims.session_id,
        user_id: claims.user_id,
        tenant_id: claims.tenant_id,
        login_provider: loginProvider,
      }),
    ),
  };
}

describe("logout at the identity provider", () => {
  test("a session from an OIDC provider returns that provider's logout URL", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/logout`, {
      method: "POST",
      headers: await headersFor("company"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("subkit_session="))).toBe(true);
    const body = (await res.json()) as { end_session_url: string };
    const url = new URL(body.end_session_url);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.url}/logout`);
    expect(url.searchParams.get("client_id")).toBe("subkit-cockpit");
    expect(url.searchParams.get("post_logout_redirect_uri")).toEndWith("/cockpit");
  });

  test("a session without a login provider keeps the plain logout", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/logout`, {
      method: "POST",
      headers: await headersFor(),
    });
    expect(res.status).toBe(204);
  });

  test("an unknown login provider keeps the plain logout", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/logout`, {
      method: "POST",
      headers: await headersFor("removed-provider"),
    });
    expect(res.status).toBe(204);
  });
});
