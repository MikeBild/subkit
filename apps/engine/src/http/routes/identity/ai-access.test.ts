import { describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { eq, like } from "drizzle-orm";
import { signLoginState } from "../../../auth/browser-session.ts";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import {
  auditLog,
  authIdentities,
  runtimeSecretVersions,
  tenants,
  users,
} from "../../../db/schema/index.ts";
import { provisionSelfServiceTenant } from "../../../identity/self-service.ts";
import { LlmAccessMissing } from "../../../llm/errors.ts";
import { initializeModel } from "../../../llm/runtime/model-init.ts";
import { invalidateAttention } from "../../../operator/attention.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { runWithTestEnv } from "../../../test-helpers/determinism/env.ts";
import {
  anthropicAnswer,
  anthropicRefusal,
  captureProcessOutput,
  stubProviderHttp,
} from "../../../test-helpers/provider-http.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../../test-helpers/workspace-registration.ts";
import {
  beginLogin,
  ctx,
  login,
  mock,
  providerId,
  responseCookie,
  setupBrowserMemberships,
} from "../../tests/memberships-fixtures.ts";
import { browserSessionHeaders } from "../../tests/setup.ts";

setupBrowserMemberships();

const OPERATOR_KEY = "sk-ant-operator-canary-0001";
const OWN_KEY = "sk-ant-workspace-canary-0001";
const NEXT_KEY = "sk-ant-workspace-canary-0002";

async function workspaceWithoutKey(subject: string) {
  const provisioned = await provisionSelfServiceTenant(
    {
      issuer_url: mock.url,
      subject,
      email: `${subject}@example.test`,
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    ctx.db,
  );
  const session = await login(subject);
  expect(session.payload.tenant_id).toBe(provisioned.tenant.id);
  return { tenantId: provisioned.tenant.id, ownerId: provisioned.membership.user_id, session };
}

async function operatorProvider<T>(model: string, run: () => Promise<T>): Promise<T> {
  await setConfigKey("llm.provider", "anthropic");
  await setConfigKey("llm.api_key", OPERATOR_KEY);
  await setConfigKey("llm.model", model);
  try {
    return await run();
  } finally {
    await setConfigKey("llm.model", "");
    await setConfigKey("llm.provider", "mock");
    invalidateAttention();
  }
}

function sessionHeaders(session: { cookie: string; csrf: string; payload: { tenant_id: string } }) {
  return {
    cookie: session.cookie,
    "x-subkit-csrf": session.csrf,
    "x-subkit-tenant": session.payload.tenant_id,
    "content-type": "application/json",
  };
}

async function aiAccess(session: { cookie: string }) {
  const response = await fetch(`${ctx.baseUrl}/v1/cockpit/bootstrap`, {
    headers: { cookie: session.cookie },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { ai_access: unknown }).ai_access;
}

async function attentionFor(headers: Record<string, string>) {
  invalidateAttention();
  const response = await fetch(`${ctx.baseUrl}/v1/attention`, { headers });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    sources: Record<string, string>;
    items: Array<{ reason: string; kind: string; class: string; actions: unknown[] }>;
  };
  return {
    source: body.sources.ai_access,
    item: body.items.find((item) => item.reason === "ai_access_missing") ?? null,
  };
}

function changeAccess(headers: Record<string, string>, body: unknown) {
  return fetch(`${ctx.baseUrl}/v1/identity/workspace/ai-access`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

async function callModel(tenantId: string) {
  const resolved = await initializeModel({ tenantId, exec: ctx.db });
  if (typeof resolved.model === "string") throw new Error("provider model expected");
  await generateText({ model: resolved.model, prompt: "Reply with OK.", maxRetries: 0 });
  return resolved;
}

describe("a hosted workspace without its own key never reaches the operator's provider", () => {
  test("every model initialisation is refused before any provider call", async () => {
    const { tenantId } = await workspaceWithoutKey("access-operator-refused");
    const provider = stubProviderHttp(() => anthropicAnswer("operator-model"));
    try {
      await operatorProvider("operator-model", async () => {
        await expect(callModel(tenantId)).rejects.toBeInstanceOf(LlmAccessMissing);
        await expect(
          initializeModel({ tenantId, exec: ctx.db, providerOverride: "openai" }),
        ).rejects.toMatchObject({ code: "ai_access_missing" });
        await expect(
          initializeModel({ tenantId, exec: ctx.db, providerOverride: "gateway" }),
        ).rejects.toBeInstanceOf(LlmAccessMissing);
      });
    } finally {
      provider.restore();
    }
    expect(provider.calls).toHaveLength(0);
  });

  test("the chat answers 409 ai_access_missing with the settings to open", async () => {
    const { session } = await workspaceWithoutKey("access-chat-refused");
    const provider = stubProviderHttp(() => anthropicAnswer("operator-model"));
    try {
      await operatorProvider("operator-model", async () => {
        const refused = await fetch(`${ctx.baseUrl}/v1/conversations`, {
          method: "POST",
          headers: sessionHeaders(session),
          body: JSON.stringify({ initial_message: "hello" }),
        });
        expect(refused.status).toBe(409);
        const body = (await refused.json()) as { code: string; message: string; hint: string };
        expect(body.code).toBe("ai_access_missing");
        expect(body.message).toContain("no AI access yet");
        expect(body.hint).toContain("Settings → AI assistant");
      });
    } finally {
      provider.restore();
    }
    expect(provider.calls).toHaveLength(0);
  });

  test("the operator's own workspace keeps calling with the engine settings", async () => {
    const provider = stubProviderHttp(() => anthropicAnswer("operator-model"));
    try {
      await operatorProvider("operator-model", async () => {
        const resolved = await callModel(ctx.tenantId);
        expect(resolved.modelId).toBe("operator-model");
      });
    } finally {
      provider.restore();
    }
    expect(provider.calls.map((call) => call.headers["x-api-key"])).toEqual([OPERATOR_KEY]);
  });
});

describe("the Cockpit reads a workspace's AI access", () => {
  test("bootstrap and attention report no access until the workspace stores its own key", async () => {
    const { tenantId, session } = await workspaceWithoutKey("access-states");
    const headers = sessionHeaders(session);

    await operatorProvider("operator-model", async () => {
      expect(await aiAccess(session)).toEqual({
        configured: false,
        provider: "anthropic",
        model: null,
        own_key: false,
      });
      const attention = await attentionFor(headers);
      expect(attention.source).toBe("answered");
      expect(attention.item).toMatchObject({
        kind: "no_access",
        class: "stopped",
        subject: { kind: "settings", id: tenantId, name: "AI access" },
        actions: [
          {
            verb: "open",
            href: "/cockpit/settings?area=ai",
            primary: true,
            permission: "identity:write",
          },
        ],
      });
    });

    const provider = stubProviderHttp(() => anthropicAnswer());
    try {
      const stored = await changeAccess(headers, {
        llm_provider: "anthropic",
        llm_api_key: OWN_KEY,
      });
      expect(stored.status).toBe(200);
      const body = await stored.text();
      expect(body).not.toContain(OWN_KEY);
      expect(JSON.parse(body)).toEqual({
        configured: true,
        provider: "anthropic",
        model: null,
        own_key: true,
      });
    } finally {
      provider.restore();
    }
    expect(await aiAccess(session)).toEqual({
      configured: true,
      provider: "anthropic",
      model: null,
      own_key: true,
    });
    expect((await attentionFor(headers)).item).toBeNull();
  });
});

describe("the workspace owner changes the AI access", () => {
  test("a new key is checked first, and a refused key leaves the stored one active", async () => {
    const { tenantId, ownerId, session } = await workspaceWithoutKey("access-replace");
    const headers = sessionHeaders(session);
    let verdict: () => Response = () => anthropicAnswer();
    const provider = stubProviderHttp(() => verdict());
    try {
      expect(
        (await changeAccess(headers, { llm_provider: "anthropic", llm_model: "claude-haiku-4-5" }))
          .status,
      ).toBe(422);
      expect(provider.calls).toHaveLength(0);

      const first = await changeAccess(headers, {
        llm_provider: "anthropic",
        llm_api_key: OWN_KEY,
      });
      expect(first.status).toBe(200);
      expect(provider.calls.map((call) => call.headers["x-api-key"])).toEqual([OWN_KEY]);

      verdict = () => anthropicRefusal(401, "authentication_error");
      let refusedBody = "";
      const output = await captureProcessOutput(async () => {
        const refused = await changeAccess(headers, {
          llm_provider: "anthropic",
          llm_api_key: NEXT_KEY,
        });
        expect(refused.status).toBe(422);
        refusedBody = await refused.text();
      });
      expect(JSON.parse(refusedBody)).toMatchObject({ code: "llm_key_rejected" });
      expect(`${refusedBody}${output}`).not.toContain(NEXT_KEY);
      expect(getConfig(tenantId).llm.api_key).toBe(OWN_KEY);

      verdict = () => anthropicRefusal(503, "overloaded_error");
      const unreachable = await changeAccess(headers, {
        llm_provider: "anthropic",
        llm_api_key: NEXT_KEY,
      });
      expect(unreachable.status).toBe(502);
      expect(await unreachable.json()).toMatchObject({ code: "llm_provider_unreachable" });
      expect(getConfig(tenantId).llm.api_key).toBe(OWN_KEY);

      verdict = () => anthropicAnswer();
      provider.calls.length = 0;
      const model = await changeAccess(headers, {
        llm_provider: "anthropic",
        llm_model: "claude-haiku-4-5",
      });
      expect(model.status).toBe(200);
      expect(await model.json()).toMatchObject({ model: "claude-haiku-4-5", own_key: true });
      expect(provider.calls.map((call) => call.headers["x-api-key"])).toEqual([OWN_KEY]);

      const otherProvider = await changeAccess(headers, { llm_provider: "openai" });
      expect(otherProvider.status).toBe(422);
      expect(await otherProvider.json()).toMatchObject({ code: "llm_key_required" });

      const replaced = await changeAccess(headers, {
        llm_provider: "anthropic",
        llm_api_key: NEXT_KEY,
      });
      expect(replaced.status).toBe(200);
      expect(getConfig(tenantId).llm.api_key).toBe(NEXT_KEY);
      expect(getConfig(tenantId).llm.model).toBe("");

      provider.calls.length = 0;
      await callModel(tenantId);
      expect(provider.calls.map((call) => call.headers["x-api-key"])).toEqual([NEXT_KEY]);
    } finally {
      provider.restore();
    }
    const audited = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, tenantId));
    const text = JSON.stringify(audited);
    expect(text).not.toContain(OWN_KEY);
    expect(text).not.toContain(NEXT_KEY);
    expect(
      audited.filter((row) => row.action === "settings.changed" && row.actor_id === ownerId).length,
    ).toBeGreaterThan(0);
  });

  test("a member who does not administer the workspace cannot change it and sees no task", async () => {
    const { tenantId } = await workspaceWithoutKey("access-member");
    const [member] = await ctx.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "access-member-colleague@example.test",
        role_id: await builtinRoleId(ctx.db, "member"),
        status: "active",
      })
      .returning();
    if (!member) throw new Error("member fixture missing");
    const headers = await browserSessionHeaders({ db: ctx.db, tenantId }, member.id);
    const provider = stubProviderHttp(() => anthropicAnswer());
    try {
      const refused = await changeAccess(headers, {
        llm_provider: "anthropic",
        llm_api_key: OWN_KEY,
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "workspace_admin_required" });
      expect(provider.calls).toHaveLength(0);
    } finally {
      provider.restore();
    }
    expect(getConfig().tenants[tenantId]).toBeUndefined();
    const attention = await attentionFor(headers);
    expect(attention.source).toBe("not_permitted");
    expect(attention.item).toBeNull();
  });
});

describe("the AI access endpoint serves self-service workspaces and answers a collision", () => {
  test("a self-hosted workspace is sent to the engine settings and nothing is stored", async () => {
    const refused = await changeAccess(
      { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      { llm_provider: "mock", llm_api_key: "test-provider-key" },
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "self_hosted_workspace" });
    expect(getConfig().tenants[ctx.tenantId]?.llm).toBeUndefined();
  });

  test("a save that cannot be activated answers 409 and keeps no key version", async () => {
    const { tenantId, session } = await workspaceWithoutKey("access-collision");
    const provider = stubProviderHttp(() => anthropicAnswer());
    let body = "";
    let status = 0;
    try {
      const output = await captureProcessOutput(async () => {
        const collided = await runWithTestEnv({ NODE_ENV: "production" }, () =>
          changeAccess(sessionHeaders(session), {
            llm_provider: "anthropic",
            llm_api_key: OWN_KEY,
          }),
        );
        status = collided.status;
        body = await collided.text();
      });
      expect(output).not.toContain(OWN_KEY);
    } finally {
      provider.restore();
    }
    expect(status).toBe(409);
    expect(JSON.parse(body)).toMatchObject({ code: "revision_conflict" });
    expect(body).not.toContain(OWN_KEY);
    expect(
      // tenant-filter:exempt — the fixture reads one workspace's versions from the product-global secret registry.
      await ctx.db
        .select({ version: runtimeSecretVersions.version })
        .from(runtimeSecretVersions)
        .where(like(runtimeSecretVersions.name, `tenants.${tenantId}.%`)),
    ).toHaveLength(0);
    expect((await aiAccess(session)) as { own_key: boolean }).toMatchObject({ own_key: false });
  });
});

describe("signing out discards a pending registration", () => {
  test("the registration cookie is cleared and its proof can create nothing afterwards", async () => {
    const pending = await beginLogin("access-logout");
    const landed = await pending.adapter.finishLogin?.(new Request(pending.callback));
    if (!landed) throw new Error("callback missing");
    const cookie = responseCookie(landed, "subkit_identity_registration");
    if (!cookie) throw new Error("registration cookie missing");
    const state = (await (
      await fetch(`${ctx.baseUrl}/v1/identity/onboarding`, { headers: { cookie } })
    ).json()) as { csrf_token: string };

    const logout = await fetch(`${ctx.baseUrl}/v1/identity/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.status).toBe(200);
    const { end_session_url: endSessionUrl } = (await logout.json()) as {
      end_session_url: string;
    };
    expect(endSessionUrl.startsWith(`${mock.url}/logout?`)).toBe(true);
    expect(new URL(endSessionUrl).searchParams.get("post_logout_redirect_uri")).toBe(
      `${ctx.baseUrl}/cockpit`,
    );
    expect(
      logout.headers
        .getSetCookie()
        .some((value) => value.startsWith("subkit_identity_registration=;")),
    ).toBe(true);

    expect(
      (await fetch(`${ctx.baseUrl}/v1/identity/onboarding`, { headers: { cookie } })).status,
    ).toBe(401);
    const late = await fetch(`${ctx.baseUrl}/v1/identity/onboarding`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-subkit-onboarding-csrf": state.csrf_token,
      },
      body: JSON.stringify({
        ...TEST_WORKSPACE_REGISTRATION,
        llm_provider: "mock",
        llm_api_key: "test-provider-key",
      }),
    });
    expect(late.status).toBe(401);
    expect(await late.json()).toMatchObject({ code: "registration_pending_required" });
    const [identity] = await ctx.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.subject, "access-logout"));
    if (!identity) throw new Error("identity missing");
    expect(
      await ctx.db.select().from(tenants).where(eq(tenants.owner_identity_id, identity.id)),
    ).toHaveLength(0);
  });

  test("when the provider offers no sign-out, the next sign-in asks which account to use", async () => {
    const pending = await beginLogin("access-logout-choice");
    const landed = await pending.adapter.finishLogin?.(new Request(pending.callback));
    if (!landed) throw new Error("callback missing");
    const cookie = responseCookie(landed, "subkit_identity_registration");
    if (!cookie) throw new Error("registration cookie missing");
    const hostedProvider = (issuerUrl: string) => [
      {
        protocol: "oidc",
        id: providerId,
        label: "Hosted",
        issuer_url: issuerUrl,
        client_id: "mock-client",
        signup_policy: "self_service",
      },
    ];
    await setConfigKey("auth.providers", hostedProvider("http://127.0.0.1:1"));
    let logout: Response;
    try {
      logout = await fetch(`${ctx.baseUrl}/v1/identity/logout`, {
        method: "POST",
        headers: { cookie },
      });
    } finally {
      await setConfigKey("auth.providers", hostedProvider(mock.url));
    }
    expect(logout.status).toBe(204);
    const choice = responseCookie(logout, "subkit_login_account_choice");
    expect(choice).toBe("subkit_login_account_choice=1");

    const loginState = await signLoginState({ redirect_to: "/cockpit" });
    const startUrl = `${ctx.baseUrl}/v1/identity/login/start?provider=${providerId}&login_state=${encodeURIComponent(loginState)}`;
    const chosen = await fetch(startUrl, {
      headers: { cookie: choice ?? "" },
      redirect: "manual",
    });
    expect(chosen.status).toBe(302);
    expect(new URL(chosen.headers.get("location") ?? "").searchParams.get("prompt")).toBe(
      "select_account",
    );
    expect(
      chosen.headers
        .getSetCookie()
        .some((value) => value.startsWith("subkit_login_account_choice=;")),
    ).toBe(true);
    const plain = await fetch(startUrl, { redirect: "manual" });
    expect(plain.status).toBe(302);
    expect(new URL(plain.headers.get("location") ?? "").searchParams.get("prompt")).toBeNull();
  });
});
