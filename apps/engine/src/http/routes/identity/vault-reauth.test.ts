import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { verifyLoginState } from "../../../auth/browser-session.ts";
import { sessions } from "../../../db/schema/index.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import {
  ctx,
  login,
  provider,
  responseCookie,
  setupBrowserMemberships,
} from "../../tests/memberships-fixtures.ts";

setupBrowserMemberships();

const CARD = {
  kind: "card",
  name: "reauth-visa",
  scope: "person",
  environment: "prod",
  value: {
    number: "4111111111111111",
    exp_month: 4,
    exp_year: new Date(getTestNow()).getUTCFullYear() + 2,
    holder: "Ada",
  },
};

type Signed = Awaited<ReturnType<typeof login>>;

function headers(session: Signed): Record<string, string> {
  return {
    cookie: session.cookie,
    "x-subkit-csrf": session.csrf,
    "x-subkit-tenant": session.payload.tenant_id,
  };
}

async function reveal(session: Signed, id: string) {
  return fetch(`${ctx.baseUrl}/v1/vault/${id}/reveal`, {
    method: "POST",
    headers: headers(session),
  });
}

describe("forced re-authentication before revealing a card", () => {
  test("an old session is refused, reauth ends it, and a fresh session may reveal", async () => {
    const first = await login("vault-reauth-owner");
    const created = await fetch(`${ctx.baseUrl}/v1/vault`, {
      method: "POST",
      headers: { ...headers(first), "content-type": "application/json" },
      body: JSON.stringify(CARD),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    await ctx.db
      .update(sessions)
      .set({ created_at: new Date(getTestNow() - 10 * 60_000) })
      .where(eq(sessions.id, first.payload.session_id));
    const refused = await reveal(first, id);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      details: { reason: "reauthentication_required", max_age_seconds: 300 },
    });

    const returnTo = `/cockpit/vault/${id}`;
    const crossSite = await fetch(
      `${ctx.baseUrl}/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}&reauth=1`,
      { headers: { cookie: first.cookie, "sec-fetch-site": "cross-site" }, redirect: "manual" },
    );
    expect(crossSite.status).toBe(302);
    expect(crossSite.headers.getSetCookie().some((c) => c.startsWith("subkit_session="))).toBe(
      false,
    );

    const start = await fetch(
      `${ctx.baseUrl}/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}&reauth=1`,
      { headers: { cookie: first.cookie, "sec-fetch-site": "same-origin" }, redirect: "manual" },
    );
    expect(start.status).toBe(302);
    expect(start.headers.getSetCookie().some((c) => c.startsWith("subkit_session=;"))).toBe(true);
    const [ended] = await ctx.db
      .select({ revoked_at: sessions.revoked_at })
      .from(sessions)
      .where(eq(sessions.id, first.payload.session_id));
    expect(ended?.revoked_at).not.toBeNull();

    const funnel = new URL(start.headers.get("location") ?? "", ctx.baseUrl);
    const state = await verifyLoginState(funnel.searchParams.get("login_state") ?? "");
    expect(state).toMatchObject({ redirect_to: returnTo, reauth: true });
    funnel.searchParams.set("provider", "hosted-browser");
    const toProvider = await fetch(funnel, { redirect: "manual" });
    expect(toProvider.status).toBe(302);
    const authorize = new URL(toProvider.headers.get("location") ?? "");
    expect(authorize.searchParams.get("prompt")).toBe("login");
    expect(authorize.searchParams.get("max_age")).toBe("0");

    const plain = await provider().startLogin?.(
      new Request(`${ctx.baseUrl}/login?redirect_to=/cockpit`),
    );
    expect(new URL(plain?.headers.get("location") ?? "").searchParams.get("prompt")).toBeNull();

    const second = await login("vault-reauth-owner");
    expect(second.payload.session_id).not.toBe(first.payload.session_id);
    const revealed = await reveal(second, id);
    expect(revealed.status).toBe(200);
    expect(responseCookie(revealed, "subkit_session")).toBeNull();
    expect(await reveal(first, id).then((r) => r.status)).toBe(401);
  });
});
