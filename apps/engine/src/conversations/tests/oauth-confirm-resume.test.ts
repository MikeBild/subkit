import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { setConfigKey } from "../../config/loader.ts";
import {
  type MockOAuthServer,
  startMockOAuthServer,
} from "../../credentials/oauth2/tests/mock-server.ts";
import { connectors, conversations } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { requestApproval } from "../../tools/approval.ts";
import { humanChatAnswer } from "../answer-actor.ts";
import { createElicitation, getElicitation, resolveElicitation } from "../elicitations.ts";
import { maybeAutoPersistFromElicitation } from "../persistence/auto-persist/index.ts";
import { getConversation } from "../service/get.ts";

let server: HttpTestServer;
let provider: MockOAuthServer;
beforeAll(async () => {
  server = await createHttpTestServer("oauth-confirm-resume");
  provider = await startMockOAuthServer();
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
});
afterAll(async () => {
  await provider?.close();
  await server?.cleanup();
});

for (const signIn of [false, true])
  test(`confirmed OAuth stays actionable; provider sign-in=${signIn}`, async () => {
    const principal: ResolvedPrincipal = {
      provider: "api_key",
      kind: "user",
      id: server.userId,
      tenant_id: server.tenantId,
      roles: ["admin"],
    };
    const [connector] = await server.db
      .insert(connectors)
      .values({
        tenant_id: server.tenantId,
        slug: `oauth-resume-${signIn}`,
        display_name: "Test account",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://api.example.test",
        config: {
          oauth: {
            issuer_url: provider.baseUrl,
            client_id: "test-client",
            client_secret: "test-secret",
            scope: "read",
          },
        },
      })
      .returning();
    const [conversation] = await server.db
      .insert(conversations)
      .values({ tenant_id: server.tenantId, owner_id: server.userId, status: "active" })
      .returning();
    const approvalId = signIn
      ? "00000000-0000-4000-8000-00000000c024"
      : "00000000-0000-4000-8000-00000000c023";
    await requestApproval({
      db: server.db,
      principal,
      approval_id: approvalId,
      tool: "authenticate_oauth",
      surface: "chat",
      via: "chat",
      reason: "computed_from_input",
      execution_mode: null,
      args: { connector_id: connector!.id },
    });
    const elicitation = await createElicitation(
      {
        tenant_id: server.tenantId,
        conversation_id: conversation!.id,
        tool_call_id: null,
        tool_name: "ask_user_confirm",
        summary: "Prepare sign-in",
        actor_id: server.userId,
        input: {
          kind: "external_write",
          question: "Prepare sign-in?",
          commit_intent: {
            kind: "execute_confirmed_tool_call",
            payload: { tool: "authenticate_oauth", approval_id: approvalId },
            description: "Prepare sign-in",
          },
        },
      },
      server.db,
    );
    await resolveElicitation(
      {
        tenant_id: server.tenantId,
        id: elicitation.id,
        output: { confirmed: true },
        decided_by: { kind: "user", id: server.userId },
      },
      server.db,
    );
    const dispatch = await maybeAutoPersistFromElicitation({
      tenant_id: server.tenantId,
      conversation_id: conversation!.id,
      actor_id: server.userId,
      principal,
      answer_actor: humanChatAnswer(principal),
      elicitation_output: { confirmed: true },
      elicitation,
      db: server.db,
    });
    expect(dispatch.synthetic_result?.ok).toBe(true);
    const detail = await getConversation(server.tenantId, conversation!.id, server.db);
    const pending = detail?.resume_summary?.pending_approval;
    expect(pending?.tool_call_id).toBe(dispatch.synthetic_tool_call_id);
    expect(pending?.prompt?.intent_kind).toBe("oauth_completed");
    expect(pending?.prompt?.question).toBeTruthy();
    expect(detail?.tool_calls.find((call) => call.id === pending?.tool_call_id)?.tool).toBe(
      "authenticate_oauth",
    );
    const followUp = await getElicitation(server.tenantId, pending!.id, server.db);
    expect(followUp).not.toBeNull();
    const authorizationUrl = (followUp!.input as { authorization_url: string }).authorization_url;
    expect(authorizationUrl).not.toContain("REDACTED");
    expect(new URL(authorizationUrl).searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pending?.prompt?.authorization_url).toBe(authorizationUrl);
    if (signIn) {
      const authorize = await fetch(authorizationUrl, { redirect: "manual" });
      expect(authorize.status).toBe(302);
      const callback = await fetch(authorize.headers.get("location")!, { redirect: "manual" });
      expect(callback.status).toBeLessThan(400);
      expect(provider.lastGrantType()).toBe("authorization_code");
    }

    await resolveElicitation(
      {
        tenant_id: server.tenantId,
        id: followUp!.id,
        output: { confirmed: true },
        decided_by: { kind: "user", id: server.userId },
      },
      server.db,
    );
    const unfinished = await maybeAutoPersistFromElicitation({
      tenant_id: server.tenantId,
      conversation_id: conversation!.id,
      actor_id: server.userId,
      principal,
      answer_actor: humanChatAnswer(principal),
      elicitation_output: { confirmed: true },
      elicitation: followUp!,
      db: server.db,
    });
    expect(unfinished.synthetic_result?.ok).toBe(signIn);
    expect(unfinished.synthetic_result?.data).toMatchObject({ authenticated: signIn });
  });
