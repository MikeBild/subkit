import { describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { and, eq, isNotNull, like, sql } from "drizzle-orm";
import { browserSessionFromRequest } from "../../../auth/browser-session.ts";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import {
  auditLog,
  authIdentities,
  knowledgeSources,
  notificationRules,
  runtimeSecretVersions,
  skills,
  tenants,
  users,
} from "../../../db/schema/index.ts";
import { REGISTRATION_PROBE_ATTEMPTS } from "../../../identity/registration.ts";
import { initializeModel } from "../../../llm/runtime/model-init.ts";
import { workspaceAiAccess } from "../../../llm/runtime/workspace-access.ts";
import { runWithTestEnv } from "../../../test-helpers/determinism/env.ts";
import {
  anthropicAnswer,
  anthropicRefusal,
  captureProcessOutput,
  stubProviderHttp,
} from "../../../test-helpers/provider-http.ts";
import {
  beginLogin,
  completeOnboarding,
  ctx,
  login,
  mock,
  providerId,
  responseCookie,
  seededWorkspaces,
  setupBrowserMemberships,
} from "../../tests/memberships-fixtures.ts";

setupBrowserMemberships();

const REGISTRATION = {
  display_name: "  Ada Lovelace ",
  workspace_name: "Analytical Engines",
  timezone: "Europe/Berlin",
  llm_provider: "mock",
  llm_api_key: "test-provider-key",
};

async function callback(subject: string, extraClaims: Record<string, unknown> = {}) {
  const pending = await beginLogin(subject, true, extraClaims);
  const response = await pending.adapter.finishLogin?.(new Request(pending.callback));
  if (!response) throw new Error("callback missing");
  return response;
}

async function identityOf(subject: string) {
  const [identity] = await ctx.db
    .select()
    .from(authIdentities)
    .where(eq(authIdentities.subject, subject));
  return identity ?? null;
}

async function ownedTenants(identityId: string) {
  return ctx.db.select().from(tenants).where(eq(tenants.owner_identity_id, identityId));
}

describe("hosted registration is completed on the welcome page", () => {
  test("an unknown verified identity gets a pending registration and no workspace at the callback", async () => {
    const response = await callback("welcome-pending", { name: "Ada Lovelace" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/cockpit/welcome");
    expect(responseCookie(response, "subkit_session")).toBeNull();
    const cookie = responseCookie(response, "subkit_identity_registration");
    if (!cookie) throw new Error("registration cookie missing");
    const identity = await identityOf("welcome-pending");
    if (!identity) throw new Error("identity missing");
    expect(await ownedTenants(identity.id)).toHaveLength(0);
    expect(
      await ctx.db.select().from(users).where(eq(users.auth_identity_id, identity.id)),
    ).toHaveLength(0);
    expect(
      await browserSessionFromRequest(new Request(ctx.baseUrl, { headers: { cookie } })),
    ).toBeNull();

    const pending = await fetch(`${ctx.baseUrl}/v1/identity/onboarding`, { headers: { cookie } });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      email: "welcome-pending@example.test",
      suggested_display_name: "Ada Lovelace",
      suggested_workspace_name: null,
    });
    expect((await fetch(`${ctx.baseUrl}/v1/identity/onboarding`)).status).toBe(401);
    expect(
      (await fetch(`${ctx.baseUrl}/v1/identity/memberships`, { headers: { cookie } })).status,
    ).toBe(401);
  });

  test("completing creates the named workspace with its owner, seeds and inbox rule exactly once", async () => {
    const response = await callback("welcome-complete");
    const cookie = responseCookie(response, "subkit_identity_registration");
    if (!cookie) throw new Error("registration cookie missing");
    const state = (await (
      await fetch(`${ctx.baseUrl}/v1/identity/onboarding`, { headers: { cookie } })
    ).json()) as { csrf_token: string; suggested_display_name: string | null };
    expect(state.suggested_display_name).toBeNull();
    const submit = (headers: Record<string, string>, body: unknown = REGISTRATION) =>
      fetch(`${ctx.baseUrl}/v1/identity/onboarding`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    expect((await submit({})).status).toBe(403);
    expect(
      (
        await submit({
          "x-subkit-onboarding-csrf": state.csrf_token,
          "sec-fetch-site": "cross-site",
        })
      ).status,
    ).toBe(403);
    const badZone = await submit(
      { "x-subkit-onboarding-csrf": state.csrf_token },
      { ...REGISTRATION, timezone: "Mars/Olympus" },
    );
    expect(badZone.status).toBe(422);
    expect(await badZone.json()).toMatchObject({ code: "invalid_timezone" });
    expect(
      (
        await submit(
          { "x-subkit-onboarding-csrf": state.csrf_token },
          { ...REGISTRATION, workspace_name: "   " },
        )
      ).status,
    ).toBe(400);
    const identity = await identityOf("welcome-complete");
    if (!identity) throw new Error("identity missing");
    expect(await ownedTenants(identity.id)).toHaveLength(0);

    const completed = await submit({ "x-subkit-onboarding-csrf": state.csrf_token });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ redirect_to: "/cockpit" });
    expect(
      completed.headers
        .getSetCookie()
        .some((value) => value.startsWith("subkit_identity_registration=;")),
    ).toBe(true);
    const session = responseCookie(completed, "subkit_session");
    if (!session) throw new Error("session cookie missing");
    const payload = await browserSessionFromRequest(
      new Request(ctx.baseUrl, { headers: { cookie: session } }),
    );
    const [tenant] = await ownedTenants(identity.id);
    if (!tenant || !payload) throw new Error("workspace missing");
    expect(payload.tenant_id).toBe(tenant.id);
    expect(tenant).toMatchObject({
      display_name: "Analytical Engines",
      timezone: "Europe/Berlin",
      origin: "self_service",
      status: "active",
    });
    expect(tenant.slug).toMatch(/^[0-9a-f-]{36}$/);
    const [owner] = await ctx.db.select().from(users).where(eq(users.tenant_id, tenant.id));
    expect(owner).toMatchObject({
      display_name: "Ada Lovelace",
      email: "welcome-complete@example.test",
      status: "active",
      auth_identity_id: identity.id,
    });
    expect(seededWorkspaces.filter((id) => id === tenant.id)).toHaveLength(1);
    const inboxRules = () =>
      ctx.db
        .select()
        .from(notificationRules)
        .where(
          and(
            eq(notificationRules.tenant_id, tenant.id),
            eq(notificationRules.target_workspace_id, "_cli"),
            eq(notificationRules.target_channel_id, "_inbox"),
          ),
        );
    expect(await inboxRules()).toHaveLength(1);

    const repeated = await submit(
      { "x-subkit-onboarding-csrf": state.csrf_token },
      { ...REGISTRATION, workspace_name: "A second workspace" },
    );
    expect(repeated.status).toBe(200);
    const repeatedSession = responseCookie(repeated, "subkit_session");
    const repeatedPayload = await browserSessionFromRequest(
      new Request(ctx.baseUrl, { headers: { cookie: repeatedSession ?? "" } }),
    );
    expect(repeatedPayload?.tenant_id).toBe(tenant.id);
    expect(await ownedTenants(identity.id)).toHaveLength(1);
    expect((await ownedTenants(identity.id))[0]?.display_name).toBe("Analytical Engines");
    expect(await ctx.db.select().from(users).where(eq(users.tenant_id, tenant.id))).toHaveLength(1);
    expect(await inboxRules()).toHaveLength(1);
    expect(seededWorkspaces.filter((id) => id === tenant.id)).toHaveLength(1);
    expect(
      (await fetch(`${ctx.baseUrl}/v1/identity/onboarding`, { headers: { cookie } })).status,
    ).toBe(401);
    expect((await login("welcome-complete")).payload.tenant_id).toBe(tenant.id);
  });

  test("an identity that left the welcome page lands there again instead of on recovery", async () => {
    await callback("welcome-abandoned");
    const again = await callback("welcome-abandoned");
    expect(again.headers.get("location")).toBe("/cockpit/welcome");
    const identity = await identityOf("welcome-abandoned");
    if (!identity) throw new Error("identity missing");
    expect(await ownedTenants(identity.id)).toHaveLength(0);
  });

  test("closed registration is reported at sign-in and refuses a pending registration at completion", async () => {
    const open = await callback("welcome-closed-late");
    const cookie = responseCookie(open, "subkit_identity_registration");
    if (!cookie) throw new Error("registration cookie missing");
    await setConfigKey("auth.hosted.registration_enabled", false);
    try {
      const pending = await beginLogin("welcome-closed");
      const refused = await pending.adapter.finishLogin?.(
        new Request(pending.callback, { headers: { accept: "application/json" } }),
      );
      expect(refused?.status).toBe(403);
      expect(await refused?.json()).toMatchObject({ code: "registration_closed" });
      expect(refused ? responseCookie(refused, "subkit_identity_registration") : "x").toBeNull();
      expect(await identityOf("welcome-closed")).toBeNull();
      const late = await completeOnboarding(cookie);
      expect(late.status).toBe(403);
      expect(await late.json()).toMatchObject({ code: "registration_closed" });
      const identity = await identityOf("welcome-closed-late");
      if (!identity) throw new Error("identity missing");
      expect(await ownedTenants(identity.id)).toHaveLength(0);
    } finally {
      await setConfigKey("auth.hosted.registration_enabled", true);
    }
  });

  test("a sign-in started by a CLI or MCP client continues to its authorization after onboarding", async () => {
    const redirectUri = "http://127.0.0.1:49152/callback";
    const registration = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: "Onboarding fixture",
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        scope: "subkit:login mcp:read",
      }),
    });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const authorizeUrl = `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      scope: "subkit:login",
      resource: `${ctx.baseUrl}/v1/identity/cli-session`,
      state: "cli-state",
    })}`;
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorize.status).toBe(302);
    const loginStart = new URL(authorize.headers.get("location") ?? "");
    expect(loginStart.pathname).toBe("/v1/identity/login/start");
    loginStart.searchParams.set("provider", providerId);
    const toProvider = await fetch(loginStart, { redirect: "manual" });
    expect(toProvider.status).toBe(302);
    const providerUrl = new URL(toProvider.headers.get("location") ?? "");
    const issued = mock.issueFor(
      { sub: "welcome-cli", email: "welcome-cli@example.test", email_verified: true },
      {
        state: providerUrl.searchParams.get("state") ?? "",
        redirect_uri: providerUrl.searchParams.get("redirect_uri") ?? "",
      },
    );
    await fetch(providerUrl, { redirect: "manual" });
    const finished = await fetch(issued.callbackUrl, { redirect: "manual" });
    expect(finished.status).toBe(302);
    expect(finished.headers.get("location")).toBe("/cockpit/welcome");
    const cookie = responseCookie(finished, "subkit_identity_registration");
    if (!cookie) throw new Error("registration cookie missing");
    const completed = await completeOnboarding(cookie);
    expect(completed.status).toBe(200);
    const { redirect_to: redirectTo } = (await completed.json()) as { redirect_to: string };
    expect(redirectTo).toBe(authorizeUrl);
    const session = responseCookie(completed, "subkit_session");
    if (!session) throw new Error("session cookie missing");
    const consent = await fetch(redirectTo, {
      headers: { cookie: session, accept: "text/html" },
      redirect: "manual",
    });
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("Onboarding fixture");
  });
});

describe("a new workspace brings its own AI provider key", () => {
  const KEY = "sk-ant-onboarding-canary-0001";
  const OWN_ACCESS = { ...REGISTRATION, llm_provider: "anthropic", llm_api_key: KEY };

  async function pending(subject: string) {
    const response = await callback(subject);
    const cookie = responseCookie(response, "subkit_identity_registration");
    if (!cookie) throw new Error("registration cookie missing");
    const state = (await (
      await fetch(`${ctx.baseUrl}/v1/identity/onboarding`, { headers: { cookie } })
    ).json()) as { csrf_token: string };
    const submit = (body: unknown) =>
      fetch(`${ctx.baseUrl}/v1/identity/onboarding`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-subkit-onboarding-csrf": state.csrf_token,
        },
        body: JSON.stringify(body),
      });
    return { cookie, submit };
  }

  async function nothingCreated(subject: string) {
    const identity = await identityOf(subject);
    if (!identity) throw new Error("identity missing");
    expect(await ownedTenants(identity.id)).toHaveLength(0);
    expect(
      await ctx.db.select().from(users).where(eq(users.auth_identity_id, identity.id)),
    ).toHaveLength(0);
  }

  async function workspaceSecrets() {
    // tenant-filter:exempt — the fixture counts workspace-owned secret versions across the whole registry.
    return ctx.db
      .select({ name: runtimeSecretVersions.name })
      .from(runtimeSecretVersions)
      .where(like(runtimeSecretVersions.name, "tenants.%"));
  }

  test("required fields are validated before any provider call", async () => {
    const provider = stubProviderHttp(() => anthropicAnswer());
    try {
      const { submit } = await pending("welcome-key-missing");
      const { llm_api_key: _key, ...withoutKey } = OWN_ACCESS;
      expect((await submit(withoutKey)).status).toBe(400);
      expect((await submit({ ...OWN_ACCESS, llm_api_key: "" })).status).toBe(400);
      expect((await submit({ ...OWN_ACCESS, llm_provider: "bedrock" })).status).toBe(400);
      const foreignModel = await submit({ ...OWN_ACCESS, llm_model: "gpt-4.1-mini" });
      expect(foreignModel.status).toBe(422);
      expect(await foreignModel.json()).toMatchObject({ code: "llm_model_unavailable" });
      expect(provider.calls).toHaveLength(0);
      await nothingCreated("welcome-key-missing");
    } finally {
      provider.restore();
    }
  });

  test("the mock provider is refused outside test and development", async () => {
    const { submit } = await pending("welcome-mock-production");
    const refused = await runWithTestEnv({ NODE_ENV: "production" }, () => submit(REGISTRATION));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "llm_provider_unavailable" });
    await nothingCreated("welcome-mock-production");
  });

  test("a key the provider refuses creates no workspace, person or secret and is never echoed", async () => {
    const provider = stubProviderHttp(() => anthropicRefusal(401, "authentication_error"));
    const secretsBefore = await workspaceSecrets();
    const overlaysBefore = Object.keys(getConfig().tenants).length;
    let body = "";
    let status = 0;
    try {
      const { submit } = await pending("welcome-key-rejected");
      const output = await captureProcessOutput(async () => {
        const refused = await submit(OWN_ACCESS);
        status = refused.status;
        body = await refused.text();
      });
      expect(output).not.toContain(KEY);
    } finally {
      provider.restore();
    }
    expect(status).toBe(422);
    expect(JSON.parse(body)).toMatchObject({ code: "llm_key_rejected" });
    expect(body).not.toContain(KEY);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.headers["x-api-key"]).toBe(KEY);
    await nothingCreated("welcome-key-rejected");
    expect(await workspaceSecrets()).toEqual(secretsBefore);
    expect(Object.keys(getConfig().tenants)).toHaveLength(overlaysBefore);
  });

  test("an unreachable provider and a refused model create nothing", async () => {
    const outage = stubProviderHttp(() => anthropicRefusal(503, "overloaded_error"));
    try {
      const { submit } = await pending("welcome-provider-down");
      const refused = await submit(OWN_ACCESS);
      expect(refused.status).toBe(502);
      expect(await refused.json()).toMatchObject({ code: "llm_provider_unreachable" });
      await nothingCreated("welcome-provider-down");
    } finally {
      outage.restore();
    }
    const unknownModel = stubProviderHttp(() => anthropicRefusal(404, "not_found_error"));
    try {
      const { submit } = await pending("welcome-model-refused");
      const refused = await submit({ ...OWN_ACCESS, llm_model: "claude-not-offered" });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ code: "llm_model_unavailable" });
      await nothingCreated("welcome-model-refused");
    } finally {
      unknownModel.restore();
    }
  });

  test("the key check is limited per sign-in", async () => {
    const provider = stubProviderHttp(() => anthropicRefusal(401, "authentication_error"));
    try {
      const { submit } = await pending("welcome-key-oracle");
      for (let attempt = 0; attempt < REGISTRATION_PROBE_ATTEMPTS; attempt += 1) {
        expect((await submit(OWN_ACCESS)).status).toBe(422);
      }
      const limited = await submit(OWN_ACCESS);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ code: "llm_probe_rate_limited" });
      expect(provider.calls).toHaveLength(REGISTRATION_PROBE_ATTEMPTS);
      await nothingCreated("welcome-key-oracle");
      const fresh = await pending("welcome-key-oracle");
      expect((await fresh.submit(OWN_ACCESS)).status).toBe(422);
    } finally {
      provider.restore();
    }
  });

  test("an accepted key creates the workspace, whose model calls use that key and reserve no operator budget", async () => {
    const provider = stubProviderHttp(() => anthropicAnswer());
    try {
      const { submit } = await pending("welcome-key-accepted");
      let body = "";
      const output = await captureProcessOutput(async () => {
        const completed = await submit({ ...OWN_ACCESS, llm_model: "claude-haiku-4-5" });
        expect(completed.status).toBe(200);
        body = await completed.text();
      });
      expect(body).not.toContain(KEY);
      expect(output).not.toContain(KEY);
      const identity = await identityOf("welcome-key-accepted");
      if (!identity) throw new Error("identity missing");
      const [tenant] = await ownedTenants(identity.id);
      if (!tenant) throw new Error("workspace missing");
      expect(workspaceAiAccess({ id: tenant.id, origin: "self_service" })).toEqual({
        configured: true,
        provider: "anthropic",
        model: "claude-haiku-4-5",
        own_key: true,
      });
      const audited = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, tenant.id));
      expect(JSON.stringify(audited)).not.toContain(KEY);
      expect(
        audited
          .filter((row) => row.action === "settings.changed")
          .map((row) => [row.resource_id, row.after])
          .sort(),
      ).toEqual([
        ["llm.api_key", "***"],
        ["llm.model", "claude-haiku-4-5"],
        ["llm.provider", "anthropic"],
      ]);

      provider.calls.length = 0;
      const resolved = await initializeModel({ tenantId: tenant.id });
      expect(resolved.provider).toBe("anthropic");
      if (typeof resolved.model === "string") throw new Error("provider model expected");
      await generateText({ model: resolved.model, prompt: "Reply with OK.", maxRetries: 0 });
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.headers["x-api-key"]).toBe(KEY);

      provider.calls.length = 0;
      const repeated = await submit({ ...OWN_ACCESS, llm_api_key: "sk-ant-another-key" });
      expect(repeated.status).toBe(200);
      expect(provider.calls).toHaveLength(0);
      expect(await ownedTenants(identity.id)).toHaveLength(1);
      expect(getConfig(tenant.id).llm.api_key).toBe(KEY);
    } finally {
      provider.restore();
    }
  });

  test("a key that could not be saved leaves a reachable workspace and the same submit stores it", async () => {
    const provider = stubProviderHttp(() => anthropicAnswer());
    try {
      const { submit } = await pending("welcome-store-failed");
      let failed = new Response();
      const output = await captureProcessOutput(async () => {
        failed = await runWithTestEnv({ NODE_ENV: "production" }, () => submit(OWN_ACCESS));
      });
      expect(output).toContain("no healthy runtime replicas are available for activation");
      expect(output).not.toContain(KEY);
      expect(failed.status).toBe(503);
      const failure = await failed.text();
      expect(JSON.parse(failure)).toMatchObject({ code: "llm_access_not_stored" });
      expect(failure).not.toContain(KEY);
      const identity = await identityOf("welcome-store-failed");
      if (!identity) throw new Error("identity missing");
      const [tenant] = await ownedTenants(identity.id);
      if (!tenant) throw new Error("workspace missing");
      expect(workspaceAiAccess({ id: tenant.id, origin: "self_service" }).own_key).toBe(false);
      const state = await ctx.db.execute<{ active: number; desired: number }>(
        sql`SELECT active_revision AS active, desired_revision AS desired FROM subkit.runtime_config_state WHERE key='runtime'`,
      );
      expect(state.rows[0]?.desired).toBe(state.rows[0]?.active);

      const stored = await submit(OWN_ACCESS);
      expect(stored.status).toBe(200);
      expect(await ownedTenants(identity.id)).toHaveLength(1);
      expect(workspaceAiAccess({ id: tenant.id, origin: "self_service" })).toMatchObject({
        own_key: true,
        provider: "anthropic",
      });
    } finally {
      provider.restore();
    }
  });
});
