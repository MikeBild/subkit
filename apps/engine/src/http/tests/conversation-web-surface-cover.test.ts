import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import { contentHash } from "../../conversations/approval-rules/scope.ts";
import { decideRule, noteApprovedAction } from "../../conversations/approval-rules/store.ts";
import { describeBoundAction } from "../../conversations/instruction-cover/bound-action.ts";
import { collectContent } from "../../conversations/instruction-cover/content.ts";
import { connectorTemplateSlug } from "../../conversations/instruction-cover/evidence.ts";
import { describeForCard } from "../../conversations/instruction-cover/gate.ts";
import { createConversation } from "../../conversations/service/index.ts";
import { conversationToolCalls, users } from "../../db/schema/index.ts";
import { writeSetupPreferences } from "../../identity/setup-preferences.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedConnector } from "../../test-helpers/seed.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let sequence = 0;
const originalProvider = testEnv.LLM_PROVIDER;
const originalMasterKey = testEnv.MASTER_KEY;

interface RecordedPolicy {
  ran_without_asking?: boolean;
  rule?: string | null;
  ask_reason?: string | null;
}

beforeAll(async () => {
  testEnv.LLM_PROVIDER = "mock";
  testEnv.MASTER_KEY = originalMasterKey ?? "a".repeat(64);
  resetMockProvider();
  srv = await createHttpTestServer("conv-web-surface-cover");
  await setConfigKey("server.public_base_url", srv.baseUrl, { force: true });
}, 120_000);

afterAll(async () => {
  if (originalProvider === undefined) delete testEnv.LLM_PROVIDER;
  else testEnv.LLM_PROVIDER = originalProvider;
  if (originalMasterKey === undefined) delete testEnv.MASTER_KEY;
  await srv.cleanup();
}, 60_000);

async function cockpitPerson(askBeforeWriting: boolean) {
  const label = `person-${++sequence}`;
  const [user] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: `${label}@web-surface.test.local`,
      role_id: await builtinRoleId(srv.db, "member"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user fixture missing");
  const owner = { tenant_id: srv.tenantId, user_id: user.id };
  await writeSetupPreferences(srv.db, owner, { ask_before_writing: askBeforeWriting });
  const headers = {
    ...(await browserSessionHeaders(srv, user.id)),
    "x-subkit-client": "cockpit",
  };
  const connector = await seedConnector(srv.db, {
    tenant_id: srv.tenantId,
    slug: `web-surface-api-${sequence}`,
  });
  const args = {
    connector_id: connector.id,
    method: "POST",
    path: "/v1/messages/send",
    body: { to: "kunde@example.com", subject: "Status", text: "Alles erledigt." },
  };
  return { owner, headers, args };
}

async function recordedPolicy(conversation_id: string): Promise<RecordedPolicy | undefined> {
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
  return (row?.confirmation_data as { policy?: RecordedPolicy } | null)?.policy;
}

async function appendFromCockpit(
  person: Awaited<ReturnType<typeof cockpitPerson>>,
  accept?: string,
): Promise<string> {
  const created = await createConversation(
    { tenant_id: srv.tenantId, actor_id: person.owner.user_id },
    srv.db,
  );
  const conversation_id = created.conversation.id;
  getMockProvider().setConversePlan(conversation_id, [
    { tool: "call_connector", args: person.args },
  ]);
  const res = await fetch(`${srv.baseUrl}/v1/conversations/${conversation_id}/messages`, {
    method: "POST",
    headers: { ...person.headers, ...(accept ? { accept } : {}) },
    body: JSON.stringify({ message: "Send the status mail to kunde@example.com." }),
  });
  expect(res.status).toBe(200);
  await res.text();
  return conversation_id;
}

describe("a connector write from a signed-in Cockpit chat", () => {
  test("asking before writing records the ask-first reason, not the session reason", async () => {
    const person = await cockpitPerson(true);
    for (const accept of [undefined, "text/event-stream"]) {
      const conversation_id = await appendFromCockpit(person, accept);
      expect(await recordedPolicy(conversation_id)).toMatchObject({
        ran_without_asking: false,
        ask_reason: "ask_before_writing",
      });
    }
  }, 180_000);

  test("an active rule the person saved lets the write run as a standing rule", async () => {
    const person = await cockpitPerson(true);
    const template = await connectorTemplateSlug(srv.db, srv.tenantId, person.args);
    const action = describeBoundAction(
      "call_connector",
      person.args,
      describeForCard("call_connector", person.args).recipients,
      { template },
    );
    const approved = contentHash(collectContent("call_connector", person.args));
    await noteApprovedAction(srv.db, person.owner, action, approved);
    const offer = await noteApprovedAction(srv.db, person.owner, action, approved);
    if (!offer) throw new Error("rule offer missing");
    await decideRule(srv.db, person.owner, offer.rule_id, "accept");
    const conversation_id = await appendFromCockpit(person);
    expect(await recordedPolicy(conversation_id)).toMatchObject({
      ran_without_asking: true,
      rule: "standing_rule",
    });
  }, 120_000);
});
