import { describe, expect, test } from "bun:test";
import { ElicitationCompleteNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import {
  createEmptyDraftDocument,
  withConnectorDraft,
  withConnectorInspection,
  withConnectorValidation,
} from "../../conversations/authoring-state/index.ts";
import { validateConnectorDraft } from "../../conversations/connector-draft.ts";
import { appendSnapshot } from "../../conversations/draft.ts";
import { markConnectorNativeUrlElicitationsComplete } from "../../conversations/native-url-elicitation.ts";
import { pauseForUserInput } from "../../conversations/tools/ask-user/common.ts";
import {
  connectors,
  conversationElicitations,
  conversationMessages,
  conversations,
  credentials,
  mcpTasks,
  workflows,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { startLocalTargetServer } from "../../test-helpers/local-http.ts";
import {
  parseEnvelope,
  readElicitationRow,
  seedPendingPrompt,
  setupNativeElicitationSuite,
  suite,
  waitForElicitationDeliveryReady,
  waitForResumedTask,
} from "./conversation-native-elicitation-fixtures.ts";

describe("MCP conversation native elicitation — real Streamable HTTP", () => {
  setupNativeElicitationSuite();

  test("conversation_get sends credential setup through URL-mode elicitation", async () => {
    const setupUrl = "https://engine.test/v1/connectors/example/credentials/setup?grant=opaque";
    let urlRequests = 0;
    let completionNotifications = 0;
    const urlClient = await suite.connectUrlElicitation(async (request) => {
      urlRequests += 1;
      expect(request.params.mode).toBe("url");
      if (request.params.mode !== "url") throw new Error("expected URL elicitation");
      expect(request.params.url).toBe(setupUrl);
      expect(request.params.elicitationId).toBeTruthy();
      return { action: "accept" };
    });
    urlClient.setNotificationHandler(ElicitationCompleteNotificationSchema, () => {
      completionNotifications += 1;
    });
    const { conversationId, elicitationId } = await seedPendingPrompt({
      tool_name: "ask_user_confirm",
      summary: "Reconnect connector",
      input: {
        question: "Did you reconnect the connector?",
        summary: "Reconnect connector securely",
        setup_url: setupUrl,
        connector_id: "example",
      },
    });

    const result = await urlClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversationId },
    });

    expect(result.isError).toBe(false);
    expect(parseEnvelope(result)).toEqual({
      status: "input_required",
      conversation_id: conversationId,
      phase: "awaiting_human_input",
      pending_elicitation_id: elicitationId,
    });
    expect(urlRequests).toBe(1);
    const accepted = await waitFor(
      async () => {
        const row = await readElicitationRow(elicitationId);
        return row?.delivery_last_error === "url_accepted" ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "URL navigation acknowledgement" },
    );
    expect(accepted.output).toBeNull();
    expect(accepted.protocol_native).toBe(true);

    const parked = await urlClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversationId },
    });
    expect(parked.isError).toBe(false);
    expect(parseEnvelope(parked)).toEqual({
      status: "input_required",
      conversation_id: conversationId,
      phase: "external_interaction_pending",
      pending_elicitation_id: elicitationId,
    });
    expect(urlRequests).toBe(1);

    await markConnectorNativeUrlElicitationsComplete(
      {
        tenant_id: suite.http.tenantId,
        connector_id: "example",
        outcome: "succeeded",
      },
      suite.http.db,
    );
    for (let attempt = 0; completionNotifications === 0 && attempt < 20; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(completionNotifications).toBe(1);

    const resumed = await urlClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversationId },
    });
    expect(resumed.isError).toBe(false);
    const stored = await readElicitationRow(elicitationId);
    expect(stored?.output).toEqual({ confirmed: true });
    expect(urlRequests).toBe(1);
    await waitForResumedTask(conversationId);
  }, 15_000);

  test("new bearer connector completes the real MCP URL journey through probe and save", async () => {
    const observed: { authorization: string | null } = { authorization: null };
    const target = await startLocalTargetServer((request) => {
      observed.authorization = request.headers.get("authorization");
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const [conversation] = await suite.http.db
        .insert(conversations)
        .values({
          tenant_id: suite.http.tenantId,
          owner_id: suite.http.userId,
          status: "active",
        })
        .returning();
      if (!conversation) throw new Error("conversation seed failed");
      await suite.http.db.insert(conversationMessages).values({
        tenant_id: suite.http.tenantId,
        conversation_id: conversation.id,
        role: "user",
        content: { text: "Create and verify a new bearer connector." },
      });
      const startedDraft = withConnectorDraft(
        createEmptyDraftDocument("connector_authoring"),
        {
          name: "Native Cloudflare Journey",
          slug: "native-cloudflare-journey",
          driver: "http",
          environment: "prod",
          base_url: target.url,
          auth_type: "bearer",
          config: {},
        },
        "connector_draft_started",
      );
      const inspectedDraft = withConnectorInspection(startedDraft);
      const validation = validateConnectorDraft(inspectedDraft.connector ?? null, []);
      const draft = withConnectorValidation(
        inspectedDraft,
        { ...inspectedDraft.connector, validation },
        validation.ok,
        "Connector draft validated.",
      );
      await appendSnapshot(suite.http.tenantId, conversation.id, draft, suite.http.db);

      const pause = await pauseForUserInput(
        {
          db: suite.http.db,
          tenant_id: suite.http.tenantId,
          conversation_id: conversation.id,
          actor_id: suite.http.userId,
          connector_id: null,
          workflow_id: null,
          engineClient: new EngineClient({
            tenant_id: suite.http.tenantId,
            actor_id: suite.http.userId,
            actor_type: "user",
            db: suite.http.db,
          }),
          getDraft: () => draft,
          setDraft: async (next) => {
            await appendSnapshot(suite.http.tenantId, conversation.id, next, suite.http.db);
          },
          abortSignal: new AbortController().signal,
          surface: "mcp",
        },
        {
          tool_name: "ask_user_form",
          summary: "Enter the Cloudflare token",
          input: {
            question: "Enter the Cloudflare token",
            fields: [{ name: "token", label: "Token", type: "password" }],
          },
        },
      );
      expect(pause.ok).toBe(true);
      if (!pause.ok || !pause.pause) throw new Error("secure setup pause missing");
      const elicitationId = pause.pause.elicitation_id;
      await suite.http.db.insert(mcpTasks).values({
        tenant_id: suite.http.tenantId,
        conversation_id: conversation.id,
        turn_seq: 1,
        kind: "start",
        actor_id: suite.http.userId,
        actor_kind: "user",
        request_source: "mcp",
        result: { conversation_id: conversation.id, status: "awaiting_input", events: [] },
      });
      getMockProvider().setConversePlan(conversation.id, [
        {
          tool: "probe_connector_draft",
          args: {
            method: "GET",
            path: "/accounts/test-account/tokens/verify",
            environment: "prod",
          },
        },
      ]);

      let setupRequests = 0;
      const urlClient = await suite.connectUrlElicitation(async (request) => {
        setupRequests += 1;
        expect(request.params.mode).toBe("url");
        if (request.params.mode !== "url") throw new Error("expected URL elicitation");
        const setupUrl = new URL(request.params.url);
        expect(setupUrl.origin).toBe(suite.http.baseUrl);
        const grant = setupUrl.searchParams.get("grant");
        if (!grant) throw new Error("setup grant missing");
        const form = await fetch(setupUrl);
        expect(form.status).toBe(200);
        const submitted = await fetch(setupUrl.origin + setupUrl.pathname, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant,
            token: "fresh-native-cloudflare-token-123",
          }).toString(),
        });
        expect(submitted.status).toBe(200);
        return { action: "accept" };
      });

      const firstPoll = await urlClient.callTool({
        name: "conversation_get",
        arguments: { conversation_id: conversation.id },
      });
      expect(firstPoll.isError).toBe(false);
      const firstBody = parseEnvelope(firstPoll);
      expect(firstBody.status).toBe("input_required");
      expect(firstBody.pending_elicitation_id).toBe(elicitationId);
      await waitFor(async () => (setupRequests >= 1 ? true : null), {
        tries: 500,
        sleepMs: 10,
        label: "URL elicitation reached the client",
      });
      await waitFor(
        async () => {
          const [row] = await suite.http.db
            .select()
            .from(conversationElicitations)
            .where(eq(conversationElicitations.id, elicitationId));
          return row?.delivery_last_error === "url_completed" ? row : null;
        },
        { tries: 500, sleepMs: 10, label: "draft credential URL completion" },
      );
      expect(setupRequests).toBe(1);

      const secondPoll = await urlClient.callTool({
        name: "conversation_get",
        arguments: { conversation_id: conversation.id },
        _meta: { sk_permission_mode: "yolo" },
      });
      expect(secondPoll.isError).toBe(false);
      await waitFor(
        async () => {
          const [row] = await suite.http.db
            .select()
            .from(conversationElicitations)
            .where(eq(conversationElicitations.id, elicitationId));
          return row?.status === "resolved" ? row : null;
        },
        { tries: 500, sleepMs: 10, label: "draft credential elicitation resolution" },
      );

      const persisted = await waitFor(
        async () => {
          const [row] = await suite.http.db
            .select()
            .from(connectors)
            .where(
              and(
                eq(connectors.tenant_id, suite.http.tenantId),
                eq(connectors.slug, "native-cloudflare-journey"),
              ),
            );
          if (!row) return null;
          const rows = await suite.http.db
            .select()
            .from(credentials)
            .where(
              and(
                eq(credentials.tenant_id, suite.http.tenantId),
                eq(credentials.connector_id, row.id),
                eq(credentials.environment, "prod"),
              ),
            );
          return rows.length === 1 ? { connector: row, credentials: rows } : null;
        },
        { tries: 500, sleepMs: 10, label: "connector auto-persist after native credential" },
      );
      expect(observed.authorization).toBe("Bearer fresh-native-cloudflare-token-123");
      expect(persisted.connector.slug).toBe("native-cloudflare-journey");
      expect(persisted.credentials).toHaveLength(1);
    } finally {
      await target.stop();
    }
  }, 30_000);

  test("a native human approval resumes the worker and performs the gated write", async () => {
    let approvalRequests = 0;
    const approvalClient = await suite.connectElicitation(async (request) => {
      approvalRequests += 1;
      expect(request.params.mode).toBe("form");
      return { action: "accept", content: { confirmed: true } };
    });
    const workflow = await suite.seedWorkflow({
      name: "Native approval delete target",
      slug: "native-approval-delete-target",
      steps: [{ id: "wait", kind: "wait", duration_ms: 1 }],
    });
    const [conversation] = await suite.http.db
      .insert(conversations)
      .values({
        tenant_id: suite.http.tenantId,
        owner_id: suite.http.userId,
        status: "active",
      })
      .returning();
    if (!conversation) throw new Error("conversation seed failed");
    getMockProvider().setConversePlan(conversation.id, [
      { tool: "delete_workflow", args: { slug: workflow.slug } },
    ]);

    const append = await approvalClient.callTool({
      name: "conversation_append",
      arguments: { conversation_id: conversation.id, message: "Delete the workflow" },
      _meta: { sk_permission_mode: "ask" },
    });
    expect(append.isError).toBe(false);

    await waitFor(
      async () => {
        const [row] = await suite.http.db
          .select({ status: conversations.status })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenant_id, suite.http.tenantId),
              eq(conversations.id, conversation.id),
            ),
          );
        return row?.status === "awaiting_input" ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "native approval pause" },
    );
    await waitForElicitationDeliveryReady(conversation.id);

    const delivery = await approvalClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversation.id },
    });
    expect(parseEnvelope(delivery).status).toBe("input_required");
    await waitForResumedTask(conversation.id);

    const storedWorkflow = await waitFor(
      async () => {
        const [row] = await suite.http.db
          .select({ deleted_at: workflows.deleted_at })
          .from(workflows)
          .where(and(eq(workflows.tenant_id, suite.http.tenantId), eq(workflows.id, workflow.id)));
        return row?.deleted_at ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "native approval gated write" },
    );

    const completed = await approvalClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversation.id },
    });
    const terminalStatus = parseEnvelope(completed).status;

    expect(approvalRequests).toBe(1);
    expect(terminalStatus).toBe("completed");
    expect(storedWorkflow.deleted_at).toBeInstanceOf(Date);
  }, 60_000);
});
