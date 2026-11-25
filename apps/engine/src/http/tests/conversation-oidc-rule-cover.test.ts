import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { browserSessionFromRequest, signBrowserCsrf } from "../../auth/browser-session.ts";
import { createOidcProvider } from "../../auth/providers/oidc.ts";
import {
  type MockOidcHandle,
  startMockOidc,
} from "../../auth/providers/tests/fixtures/mock-oidc.ts";
import { setConfigKey } from "../../config/loader.ts";
import { contentHash } from "../../conversations/approval-rules/scope.ts";
import { noteApprovedAction } from "../../conversations/approval-rules/store.ts";
import { describeBoundAction } from "../../conversations/instruction-cover/bound-action.ts";
import { collectContent } from "../../conversations/instruction-cover/content.ts";
import { connectorTemplateSlug } from "../../conversations/instruction-cover/evidence.ts";
import { describeForCard } from "../../conversations/instruction-cover/gate.ts";
import { createConversation } from "../../conversations/service/index.ts";
import { conversationToolCalls, tenants, users } from "../../db/schema/index.ts";
import { writeSetupPreferences } from "../../identity/setup-preferences.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedConnector } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let idp: MockOidcHandle;
const originalProvider = testEnv.LLM_PROVIDER;
const originalMasterKey = testEnv.MASTER_KEY;

beforeAll(async () => {
  testEnv.LLM_PROVIDER = "mock";
  testEnv.MASTER_KEY = originalMasterKey ?? "a".repeat(64);
  resetMockProvider();
  srv = await createHttpTestServer("conv-oidc-rule-cover");
  idp = await startMockOidc();
  await setConfigKey("server.public_base_url", srv.baseUrl, { force: true });
}, 120_000);

afterAll(async () => {
  if (originalProvider === undefined) delete testEnv.LLM_PROVIDER;
  else testEnv.LLM_PROVIDER = originalProvider;
  if (originalMasterKey === undefined) delete testEnv.MASTER_KEY;
  await idp.stop();
  await srv.cleanup();
}, 60_000);

async function signInThroughBrowserOidc(email: string): Promise<Record<string, string>> {
  const [tenant] = await srv.db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, srv.tenantId));
  if (!tenant) throw new Error("tenant fixture missing");
  const redirectUri = `${srv.baseUrl}/v1/identity/login/callback`;
  const adapter = createOidcProvider({
    db: srv.db,
    providerId: "company",
    issuerUrl: idp.url,
    clientId: "subkit-cockpit",
    redirectUri,
    tenantSlug: tenant.slug,
  });
  const start = await adapter.startLogin?.(
    new Request(`${srv.baseUrl}/v1/identity/login/start?redirect_to=/cockpit`),
  );
  const location = start?.headers.get("location");
  if (!location) throw new Error("authorize location missing");
  const state = new URL(location).searchParams.get("state") ?? "";
  await fetch(location, { redirect: "manual" });
  const issued = idp.issueFor(
    { sub: `sub-${email}`, email, email_verified: true },
    { state, redirect_uri: redirectUri },
  );
  const finished = await adapter.finishLogin?.(new Request(issued.callbackUrl));
  expect(finished?.status).toBe(302);
  const cookie = finished?.headers
    .getSetCookie()
    .find((value) => value.startsWith("subkit_session=") && !value.startsWith("subkit_session=;"))
    ?.split(";")[0];
  if (!cookie) throw new Error("oidc session cookie missing");
  const payload = await browserSessionFromRequest(
    new Request(srv.baseUrl, { headers: { cookie } }),
  );
  if (!payload) throw new Error("oidc session payload missing");
  return {
    cookie,
    "x-subkit-csrf": await signBrowserCsrf(payload),
    "content-type": "application/json",
    "x-subkit-client": "cockpit",
  };
}

async function recordedPolicy(conversation_id: string) {
  const [row] = await srv.db
    .select({ confirmation_data: conversationToolCalls.confirmation_data })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, srv.tenantId),
        eq(conversationToolCalls.conversation_id, conversation_id),
        eq(conversationToolCalls.tool, "call_connector"),
      ),
    );
  return (row?.confirmation_data as { policy?: Record<string, unknown> } | null)?.policy;
}

describe("a personal rule saved after browser OIDC sign-in", () => {
  test("covers the identical third note from the same signed-in Cockpit chat", async () => {
    const email = "cedar-member@oidc-rule.test.local";
    const [member] = await srv.db
      .insert(users)
      .values({
        tenant_id: srv.tenantId,
        email,
        role_id: await builtinRoleId(srv.db, "member"),
      })
      .returning({ id: users.id });
    if (!member) throw new Error("member fixture missing");
    const owner = { tenant_id: srv.tenantId, user_id: member.id };
    await writeSetupPreferences(srv.db, owner, { ask_before_writing: true });
    const headers = await signInThroughBrowserOidc(email);

    const whoami = await fetch(`${srv.baseUrl}/v1/identity/me/setup`, { headers });
    expect(whoami.status).toBe(200);

    const connector = await seedConnector(srv.db, {
      tenant_id: srv.tenantId,
      slug: "cedar-notes",
    });
    const args = {
      connector_id: connector.id,
      method: "POST",
      path: "/notes",
      body: { text: "Cedar fixed shift update amber" },
    };
    const template = await connectorTemplateSlug(srv.db, srv.tenantId, args);
    const action = describeBoundAction(
      "call_connector",
      args,
      describeForCard("call_connector", args).recipients,
      { template },
    );
    const approved = contentHash(collectContent("call_connector", args));
    await noteApprovedAction(srv.db, owner, action, approved);
    const offer = await noteApprovedAction(srv.db, owner, action, approved);
    if (!offer) throw new Error("rule offer missing");

    const accepted = await fetch(`${srv.baseUrl}/v1/approval-rules/${offer.rule_id}/accept`, {
      method: "POST",
      headers,
    });
    expect(accepted.status).toBe(200);

    const created = await createConversation(
      { tenant_id: srv.tenantId, actor_id: member.id },
      srv.db,
    );
    const conversation_id = created.conversation.id;
    getMockProvider().setConversePlan(conversation_id, [{ tool: "call_connector", args }]);
    const third = await fetch(`${srv.baseUrl}/v1/conversations/${conversation_id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: "Create the note “Cedar fixed shift update amber” in Cedar Notes.",
      }),
    });
    expect(third.status).toBe(200);
    await third.text();
    expect(await recordedPolicy(conversation_id)).toMatchObject({
      ran_without_asking: true,
      rule: "standing_rule",
    });
  }, 180_000);
});
