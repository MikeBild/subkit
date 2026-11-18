import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { authIdentities, tenants } from "../../../db/schema/index.ts";
import {
  REGISTRATION_PROBE_ATTEMPTS,
  REGISTRATION_REDIRECT_MAX,
} from "../../../identity/registration.ts";
import { workspaceAiAccess } from "../../../llm/runtime/workspace-access.ts";
import { getRuntimeConfigState, saveRuntimeConfigPatch } from "../../../runtime-config/service.ts";
import { runWithTestEnv } from "../../../test-helpers/determinism/env.ts";
import {
  anthropicAnswer,
  captureProcessOutput,
  stubProviderHttp,
} from "../../../test-helpers/provider-http.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../../test-helpers/workspace-registration.ts";
import {
  beginLogin,
  completeOnboarding,
  ctx,
  provider as hostedAdapter,
  mock,
  responseCookie,
  setupBrowserMemberships,
} from "../../tests/memberships-fixtures.ts";

setupBrowserMemberships();

const OWN_ACCESS = {
  ...TEST_WORKSPACE_REGISTRATION,
  llm_provider: "anthropic",
  llm_api_key: "sk-ant-onboarding-guard-0001",
};

async function pending(subject: string) {
  const login = await beginLogin(subject);
  const landed = await login.adapter.finishLogin?.(new Request(login.callback));
  const cookie = landed ? responseCookie(landed, "subkit_identity_registration") : null;
  if (!cookie) throw new Error("registration cookie missing");
  const state = (await (
    await fetch(`${ctx.baseUrl}/v1/identity/onboarding`, { headers: { cookie } })
  ).json()) as { csrf_token: string };
  const submit = () =>
    fetch(`${ctx.baseUrl}/v1/identity/onboarding`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-subkit-onboarding-csrf": state.csrf_token,
      },
      body: JSON.stringify(OWN_ACCESS),
    });
  return { cookie, submit };
}

async function ownedWorkspaces(subject: string) {
  const [identity] = await ctx.db
    .select()
    .from(authIdentities)
    .where(eq(authIdentities.subject, subject));
  if (!identity) throw new Error("identity missing");
  const owned = await ctx.db
    .select()
    .from(tenants)
    .where(eq(tenants.owner_identity_id, identity.id));
  return { owned };
}

test("a sign-in destination is carried through registration up to its limit and refused beyond it", async () => {
  const start = (redirectTo: string) =>
    hostedAdapter().startLogin?.(
      new Request(`${ctx.baseUrl}/login?redirect_to=${encodeURIComponent(redirectTo)}`, {
        headers: { accept: "application/json" },
      }),
    );
  const prefix = "/cockpit?next=";
  const tooLong = await start(`${prefix}${"x".repeat(REGISTRATION_REDIRECT_MAX)}`);
  expect(tooLong?.status).toBe(400);
  expect(await tooLong?.json()).toMatchObject({ code: "redirect_too_long" });

  const longest = `${prefix}${"x".repeat(REGISTRATION_REDIRECT_MAX - prefix.length)}`;
  const accepted = await start(longest);
  expect(accepted?.status).toBe(302);
  const location = accepted?.headers.get("location") ?? "";
  const issued = mock.issueFor(
    { sub: "guard-long", email: "guard-long@example.test", email_verified: true },
    {
      state: new URL(location).searchParams.get("state") ?? "",
      redirect_uri: `${ctx.baseUrl}/v1/identity/login/callback`,
    },
  );
  await fetch(location, { redirect: "manual" });
  const landed = await hostedAdapter().finishLogin?.(new Request(issued.callbackUrl));
  const cookie = landed ? responseCookie(landed, "subkit_identity_registration") : null;
  if (!cookie) throw new Error("registration cookie missing");
  const completed = await completeOnboarding(cookie);
  expect(completed.status).toBe(200);
  expect(await completed.json()).toEqual({ redirect_to: longest });
});

test("a pending operator change refuses the registration before the key check and costs no attempt", async () => {
  const provider = stubProviderHttp(() => anthropicAnswer());
  try {
    const { submit } = await pending("guard-operator-pending");
    const state = await getRuntimeConfigState(ctx.db);
    await saveRuntimeConfigPatch(ctx.db, {
      expected_revision: state.saved_revision,
      changes: { "log.level": "warn" },
      scope: "global",
      created_by: null,
    });
    try {
      for (let attempt = 0; attempt <= REGISTRATION_PROBE_ATTEMPTS; attempt += 1) {
        const blocked = await submit();
        expect(blocked.status).toBe(503);
        expect(await blocked.json()).toMatchObject({ code: "registration_policy_unavailable" });
      }
      expect(provider.calls).toHaveLength(0);
      expect((await ownedWorkspaces("guard-operator-pending")).owned).toHaveLength(0);
    } finally {
      await ctx.db.execute(
        sql`UPDATE subkit.runtime_config_state SET desired_revision = active_revision WHERE key='runtime'`,
      );
    }
    expect((await submit()).status).toBe(200);
    expect(provider.calls).toHaveLength(1);
  } finally {
    provider.restore();
  }
});

test("signing out makes a registration proof useless even when its workspace already exists", async () => {
  const provider = stubProviderHttp(() => anthropicAnswer());
  try {
    const { cookie, submit } = await pending("guard-replay");
    let failed = new Response();
    await captureProcessOutput(async () => {
      failed = await runWithTestEnv({ NODE_ENV: "production" }, () => submit());
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "llm_access_not_stored" });
    const { owned } = await ownedWorkspaces("guard-replay");
    const tenant = owned[0];
    if (!tenant) throw new Error("workspace missing");

    const logout = await fetch(`${ctx.baseUrl}/v1/identity/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.ok).toBe(true);
    provider.calls.length = 0;
    const replayed = await submit();
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toMatchObject({ code: "registration_pending_required" });
    expect(responseCookie(replayed, "subkit_session")).toBeNull();
    expect(provider.calls).toHaveLength(0);
    expect(workspaceAiAccess({ id: tenant.id, origin: "self_service" }).own_key).toBe(false);
  } finally {
    provider.restore();
  }
});
