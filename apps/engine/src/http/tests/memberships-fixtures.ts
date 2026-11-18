import { afterAll, beforeAll, expect } from "bun:test";
import { browserSessionFromRequest, signBrowserCsrf } from "../../auth/browser-session.ts";
import { createOidcProvider } from "../../auth/providers/oidc.ts";
import {
  type MockOidcHandle,
  startMockOidc,
} from "../../auth/providers/tests/fixtures/mock-oidc.ts";
import { setConfigKey } from "../../config/loader.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../test-helpers/workspace-registration.ts";
import { _resetConfigForTests, createHttpTestServer, type HttpTestServer } from "./setup.ts";

export let uuid = createDeterministicUuidFactory(811);

export let ctx: HttpTestServer;

export let mock: MockOidcHandle;

export const providerId = "hosted-browser";

export function provider() {
  return createOidcProvider({
    db: ctx.db,
    providerId,
    redirectUri: `${ctx.baseUrl}/v1/identity/login/callback`,
  });
}

export async function beginLogin(
  subject: string,
  verified = true,
  extraClaims: Record<string, unknown> = {},
) {
  const adapter = provider();
  const start = await adapter.startLogin?.(
    new Request(`${ctx.baseUrl}/login?tenant=arbitrary-tenant&redirect_to=/cockpit`),
  );
  if (!start) throw new Error("start missing");
  expect(start.status).toBe(302);
  const location = start.headers.get("location");
  if (!location) throw new Error("authorize location missing");
  const authUrl = new URL(location);
  const state = authUrl.searchParams.get("state");
  if (!state) throw new Error("state missing");
  const issued = mock.issueFor(
    { sub: subject, email: `${subject}@example.test`, email_verified: verified, ...extraClaims },
    { state, redirect_uri: `${ctx.baseUrl}/v1/identity/login/callback` },
  );
  await fetch(location, { redirect: "manual" });
  return { adapter, callback: issued.callbackUrl };
}

export function responseCookie(response: Response, name: string): string | null {
  return (
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`))
      ?.split(";")[0] ?? null
  );
}

export async function completeOnboarding(
  registrationCookie: string,
  registration: {
    display_name: string;
    workspace_name: string;
    timezone: string;
  } = TEST_WORKSPACE_REGISTRATION,
) {
  const pending = await fetch(`${ctx.baseUrl}/v1/identity/onboarding`, {
    headers: { cookie: registrationCookie },
  });
  expect(pending.status).toBe(200);
  const state = (await pending.json()) as { csrf_token: string };
  return fetch(`${ctx.baseUrl}/v1/identity/onboarding`, {
    method: "POST",
    headers: {
      cookie: registrationCookie,
      "content-type": "application/json",
      "x-subkit-onboarding-csrf": state.csrf_token,
    },
    body: JSON.stringify({
      ...registration,
      llm_provider: "mock",
      llm_api_key: "test-provider-key",
    }),
  });
}

export async function login(subject: string) {
  const pending = await beginLogin(subject);
  let response = await pending.adapter.finishLogin?.(new Request(pending.callback));
  if (!response) throw new Error("callback missing");
  expect(response.status).toBe(302);
  if (response.headers.get("location") === "/cockpit/welcome") {
    const registrationCookie = responseCookie(response, "subkit_identity_registration");
    if (!registrationCookie) throw new Error("registration cookie missing");
    response = await completeOnboarding(registrationCookie);
    expect(response.status).toBe(200);
  }
  const cookie = responseCookie(response, "subkit_session");
  if (!cookie) throw new Error("session cookie missing");
  const payload = await browserSessionFromRequest(
    new Request(ctx.baseUrl, { headers: { cookie } }),
  );
  if (!payload) throw new Error("session payload missing");
  return { cookie, payload, csrf: await signBrowserCsrf(payload) };
}

export function setupBrowserMemberships(): void {
  uuid = createDeterministicUuidFactory(811);
  beforeAll(async () => {
    _resetConfigForTests();
    ctx = await createHttpTestServer("browser-memberships");
    await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
    mock = await startMockOidc();
    await setConfigKey("server.public_base_url", ctx.baseUrl);
    await setConfigKey("auth.hosted.enabled", true);
    await setConfigKey("llm.hosted.enabled", true);
    await setConfigKey("llm.hosted.tenant_monthly_microunits", "1000000");
    await setConfigKey("llm.hosted.global_monthly_microunits", "10000000");
    await setConfigKey("llm.hosted.models", [
      {
        model: "anthropic:billing-model",
        max_context_tokens: 1000,
        max_output_tokens: 100,
        input_usd_per_million_tokens: "3",
        output_usd_per_million_tokens: "15",
        cache_read_usd_per_million_tokens: "0.3",
        cache_write_5m_usd_per_million_tokens: "3.75",
        cache_write_1h_usd_per_million_tokens: "6",
      },
    ]);
    await setConfigKey("storage.hosted.retained_rows_per_resource", 1000);
    await setConfigKey("storage.hosted.tenant_bytes", "1000000");
    await setConfigKey("storage.hosted.max_file_bytes", "100000");
    await setConfigKey("server.hosted_rate_limit.peer_per_minute", 1000);
    await setConfigKey("server.hosted_rate_limit.principal_per_minute", 1000);
    await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
    await setConfigKey("server.hosted_rate_limit.tenant_per_minute", 1000);
    await setConfigKey("server.hosted_rate_limit.global_per_minute", 1000);
    await setConfigKey("queue.hosted.execution_concurrency", 1);
    await setConfigKey("queue.hosted.chat_concurrency", 1);
    await setConfigKey("queue.hosted.pending_jobs", 10);
    await setConfigKey("auth.hosted.registration_enabled", true);
    await setConfigKey("auth.enable_signup", false);
    await setConfigKey("auth.providers", [
      {
        protocol: "oidc",
        id: providerId,
        label: "Hosted",
        issuer_url: mock.url,
        client_id: "mock-client",
        signup_policy: "self_service",
      },
    ]);
  });
  afterAll(async () => {
    if (mock) await mock.stop();
    if (ctx) await ctx.cleanup();
  });
}
