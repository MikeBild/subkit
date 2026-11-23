import { describe, expect, spyOn, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { verifyBrowserSession } from "../../../auth/browser-session.ts";
import { desktopLoginCodes, sessions, users } from "../../../db/schema/index.ts";
import { provisionSelfServiceTenant } from "../../../identity/index.ts";
import { logger } from "../../../logging/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../../test-helpers/workspace-registration.ts";
import { ctx, login, mock, setupBrowserMemberships } from "../../tests/memberships-fixtures.ts";

setupBrowserMemberships();

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "state-0123456789abcdef";
const DEVICE_ID = "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

async function startDesktopLogin(cookie: string): Promise<string> {
  const params = new URLSearchParams({
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: STATE,
    device_id: DEVICE_ID,
    device_label: "Mike's MacBook",
    app_version: "12.1.3",
  });
  const start = await fetch(`${ctx.baseUrl}/v1/identity/desktop-login/start?${params}`, {
    headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
    redirect: "manual",
  });
  expect(start.status).toBe(302);
  const location = start.headers.get("location");
  if (!location) throw new Error("confirm location missing");
  return new URL(location, ctx.baseUrl).toString();
}

async function openConfirm(confirmUrl: string, cookie: string) {
  const page = await fetch(confirmUrl, {
    headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
    redirect: "manual",
  });
  const html = await page.text();
  expect(html).not.toContain("tenant_context_changed");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(html).toContain('data-testid="desktop-login-confirm"');
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1];
  if (!request || !csrf) throw new Error("confirm form fields missing");
  return { html, request, csrf };
}

function approve(cookie: string, request: string, csrf: string) {
  return fetch(`${ctx.baseUrl}/v1/identity/desktop-login/confirm`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
    },
    body: new URLSearchParams({ request, csrf_token: csrf, decision: "approve" }).toString(),
    redirect: "manual",
  });
}

describe("desktop sign-in with a hosted browser session", () => {
  test("a person signed in to the Cockpit confirms the device without a workspace header", async () => {
    const owner = await login("desktop-signed-in");
    const confirmUrl = await startDesktopLogin(owner.cookie);
    const form = await openConfirm(confirmUrl, owner.cookie);
    expect(form.html).toContain("desktop-signed-in@example.test");
    const approved = await approve(owner.cookie, form.request, form.csrf);
    expect(approved.status).toBe(303);
    const callback = new URL(approved.headers.get("location") ?? "");
    expect(`${callback.protocol}//${callback.host}`).toBe("subkit://callback");
    expect(callback.searchParams.get("state")).toBe(STATE);
    expect(callback.searchParams.get("code")).toBeTruthy();
    const [issued] = await ctx.db
      .select({ tenant_id: desktopLoginCodes.tenant_id })
      .from(desktopLoginCodes)
      .where(eq(desktopLoginCodes.tenant_id, owner.payload.tenant_id));
    expect(issued?.tenant_id).toBe(owner.payload.tenant_id);
  });

  test("a workspace switch between the page and the approval shows the page again for the new workspace", async () => {
    const owner = await login("desktop-switcher");
    const destination = await provisionSelfServiceTenant(
      {
        issuer_url: mock.url,
        subject: "desktop-destination-owner",
        email: "desktop-destination@example.test",
        email_verified: true,
      },
      { ...TEST_WORKSPACE_REGISTRATION, workspace_name: "Destination workspace" },
      ctx.db,
    );
    const [source] = await ctx.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tenant_id, owner.payload.tenant_id),
          eq(sessions.id, owner.payload.session_id),
        ),
      );
    if (!source?.auth_identity_id) throw new Error("OIDC proof missing");
    await ctx.db.insert(users).values({
      tenant_id: destination.tenant.id,
      auth_identity_id: source.auth_identity_id,
      email: "desktop-switcher@example.test",
      role_id: await builtinRoleId(ctx.db, "member"),
    });

    const confirmUrl = await startDesktopLogin(owner.cookie);
    const stale = await openConfirm(confirmUrl, owner.cookie);
    expect(stale.html).not.toContain("Destination workspace");

    const switched = await fetch(`${ctx.baseUrl}/v1/identity/tenant-session`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "x-subkit-csrf": owner.csrf,
        "x-subkit-tenant": owner.payload.tenant_id,
      },
      body: JSON.stringify({ tenant_id: destination.tenant.id }),
    });
    expect(switched.status).toBe(200);
    const nextCookie = switched.headers.get("set-cookie")?.split(";")[0];
    if (!nextCookie) throw new Error("switched cookie missing");
    const nextPayload = await verifyBrowserSession(nextCookie.slice("subkit_session=".length));
    expect(nextPayload?.tenant_id).toBe(destination.tenant.id);

    const retry = await approve(nextCookie, stale.request, stale.csrf);
    expect(retry.status).toBe(303);
    const back = new URL(retry.headers.get("location") ?? "", ctx.baseUrl);
    expect(back.pathname).toBe("/v1/identity/desktop-login/confirm");
    expect(back.searchParams.get("request")).toBe(stale.request);
    expect(
      await ctx.db
        .select()
        .from(desktopLoginCodes)
        .where(eq(desktopLoginCodes.tenant_id, destination.tenant.id)),
    ).toHaveLength(0);

    const fresh = await openConfirm(back.toString(), nextCookie);
    expect(fresh.html).toContain("Destination workspace");
    const approved = await approve(nextCookie, fresh.request, fresh.csrf);
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toStartWith("subkit://callback?");
    const [issued] = await ctx.db
      .select({ tenant_id: desktopLoginCodes.tenant_id })
      .from(desktopLoginCodes)
      .where(eq(desktopLoginCodes.tenant_id, destination.tenant.id));
    expect(issued?.tenant_id).toBe(destination.tenant.id);
  });
});

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

async function signInDesktop(subject: string) {
  const owner = await login(subject);
  const form = await openConfirm(await startDesktopLogin(owner.cookie), owner.cookie);
  const approved = await approve(owner.cookie, form.request, form.csrf);
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error("desktop code missing");
  const exchanged = await fetch(`${ctx.baseUrl}/v1/identity/desktop-session`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code, code_verifier: VERIFIER, app_version: "12.1.4" }),
  });
  expect(exchanged.status).toBe(200);
  const { cockpit_path } = (await exchanged.json()) as { cockpit_path: string };
  const cookie = exchanged.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("installation cookie missing");
  return { cookie, api: `${ctx.baseUrl}${cockpit_path}api` };
}

describe("desktop device session after a hosted OIDC sign-in", () => {
  test("the event stream and attention connect without a workspace header", async () => {
    const device = await signInDesktop("desktop-stream");
    const controller = new AbortController();
    const stream = await fetch(`${device.api}/v1/cockpit/events/stream`, {
      headers: { cookie: device.cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
    const attention = await fetch(`${device.api}/v1/attention`, {
      headers: { cookie: device.cookie, accept: "application/json" },
    });
    expect(attention.status).toBe(200);
  });

  test("a device request naming another workspace is still refused", async () => {
    const device = await signInDesktop("desktop-other-tenant");
    const response = await fetch(`${device.api}/v1/attention`, {
      headers: {
        cookie: device.cookie,
        accept: "application/json",
        "x-subkit-tenant": "00000000-0000-4000-8000-000000000099",
      },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("tenant_context_changed");
  });

  test("the event stream and runner enrollment from a device stay free of tenant-context noise", async () => {
    const device = await signInDesktop("desktop-quiet-routes");
    const warn = spyOn(logger, "warn");
    try {
      const controller = new AbortController();
      const stream = await fetch(`${device.api}/v1/cockpit/events/stream`, {
        headers: {
          cookie: device.cookie,
          accept: "text/event-stream",
          "sec-fetch-mode": "no-cors",
        },
        signal: controller.signal,
      });
      expect(stream.status).toBe(200);
      controller.abort();
      const enroll = await fetch(`${device.api}/v1/devices/runner/enroll`, {
        method: "POST",
        headers: {
          cookie: device.cookie,
          accept: "application/json",
          "content-type": "application/json",
          "sec-fetch-mode": "no-cors",
        },
        body: JSON.stringify({ public_key: RUNNER_PUBLIC_KEY, runner_version: "12.1.6" }),
      });
      expect(enroll.status).not.toBe(409);
      const actions = warn.mock.calls.map((call) => (call[0] as { action?: string }).action);
      expect(actions).not.toContain("browser_tenant.context_changed");
    } finally {
      warn.mockRestore();
    }
  });

  test("a plain browser session on the same routes still needs its workspace header", async () => {
    const owner = await login("desktop-plain-browser");
    const enroll = await fetch(`${ctx.baseUrl}/v1/devices/runner/enroll`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        accept: "application/json",
        "content-type": "application/json",
        "x-subkit-csrf": owner.csrf,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      },
      body: JSON.stringify({ public_key: RUNNER_PUBLIC_KEY }),
    });
    expect(enroll.status).toBe(409);
    const stream = await fetch(`${ctx.baseUrl}/v1/cockpit/events/stream`, {
      headers: { cookie: owner.cookie, accept: "text/event-stream", "sec-fetch-mode": "cors" },
    });
    expect(stream.status).toBe(409);
  });
});

const RUNNER_PUBLIC_KEY = createPublicKey(
  createPrivateKey({
    key: Buffer.from(`302e020100300506032b657004220420${"11".repeat(32)}`, "hex"),
    format: "der",
    type: "pkcs8",
  }),
)
  .export({ type: "spki", format: "pem" })
  .toString();
