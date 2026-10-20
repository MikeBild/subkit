import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitationCompleteNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, desc, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import {
  createEmptyDraftDocument,
  withConnectorDraft,
  withConnectorInspection,
  withConnectorValidation,
} from "../../conversations/authoring-state.ts";
import { validateConnectorDraft } from "../../conversations/connector-draft.ts";
import { appendSnapshot } from "../../conversations/draft.ts";
import { markConnectorNativeUrlElicitationsComplete } from "../../conversations/native-url-elicitation.ts";
import { pauseForUserInput } from "../../conversations/tools/ask-user/common.ts";
import {
  auditLog,
  connectors,
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationTurns,
  credentials,
  mcpTasks,
  workflows,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { startLocalTargetServer } from "../../test-helpers/local-http.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

function parseEnvelope(result: unknown): Record<string, unknown> {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const item = r.content?.[0];
  return JSON.parse(item?.type === "text" ? (item.text ?? "{}") : "{}") as Record<string, unknown>;
}

describe("MCP conversation native elicitation — real Streamable HTTP", () => {
  let suite: McpTestSuite;
  let client: Client;
  let requests = 0;

  beforeAll(async () => {
    process.env.LLM_PROVIDER = "mock";
    suite = await startMcpTestSuite("conversation-native-elicitation", { withQueue: true });
    await setConfigKey("server.public_base_url", suite.http.baseUrl, { force: true });
    client = await suite.connectElicitation(async (request) => {
      requests += 1;
      expect(request.params.mode).toBe("form");
      expect(request.params.message).toBe("Choose rollout");
      return { action: "accept", content: { value: "canary" } };
    });
  });

  afterAll(async () => {
    await suite.cleanup();
  });

  async function seedResumeContext(conversationId: string): Promise<void> {
    await suite.http.db.insert(conversationMessages).values({
      tenant_id: suite.http.tenantId,
      conversation_id: conversationId,
      role: "user",
      content: { text: "Continue after the requested input." },
    });
    getMockProvider().setConversePlan(conversationId, []);
  }

  async function seedPendingPrompt(p: {
    tool_name?: string;
    summary: string;
    input: Record<string, unknown>;
  }): Promise<{ conversationId: string; elicitationId: string; taskId: string }> {
    const [conversation] = await suite.http.db
      .insert(conversations)
      .values({
        tenant_id: suite.http.tenantId,
        owner_id: suite.http.userId,
        status: "awaiting_input",
      })
      .returning();
    if (!conversation) throw new Error("conversation seed failed");
    await seedResumeContext(conversation.id);
    const [elicitation] = await suite.http.db
      .insert(conversationElicitations)
      .values({
        tenant_id: suite.http.tenantId,
        conversation_id: conversation.id,
        tool_name: p.tool_name ?? "ask_user_choice",
        summary: p.summary,
        input: p.input,
      })
      .returning();
    if (!elicitation) throw new Error("elicitation seed failed");
    const [taskRow] = await suite.http.db
      .insert(mcpTasks)
      .values({
        tenant_id: suite.http.tenantId,
        conversation_id: conversation.id,
        turn_seq: 1,
        kind: "start",
        actor_id: suite.http.userId,
        actor_kind: "user",
        request_source: "mcp",
        result: { conversation_id: conversation.id, status: "awaiting_input", events: [] },
      })
      .returning();
    if (!taskRow) throw new Error("task seed failed");
    return { conversationId: conversation.id, elicitationId: elicitation.id, taskId: taskRow.id };
  }

  async function readElicitationRow(elicitationId: string) {
    const [row] = await suite.http.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, suite.http.tenantId),
          eq(conversationElicitations.id, elicitationId),
        ),
      );
    return row;
  }

  async function readConversationStatus(conversationId: string): Promise<string | undefined> {
    const [row] = await suite.http.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(
        and(eq(conversations.tenant_id, suite.http.tenantId), eq(conversations.id, conversationId)),
      );
    return row?.status;
  }

  async function listAuditRows(elicitationId: string, action: string) {
    return suite.http.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, suite.http.tenantId),
          eq(auditLog.resource_type, "conversation_elicitation"),
          eq(auditLog.resource_id, elicitationId),
          eq(auditLog.action, action),
        ),
      );
  }

  async function waitForResumedTask(conversationId: string): Promise<void> {
    await waitFor(
      async () => {
        const [row] = await suite.http.db
          .select()
          .from(mcpTasks)
          .where(
            and(
              eq(mcpTasks.tenant_id, suite.http.tenantId),
              eq(mcpTasks.conversation_id, conversationId),
              eq(mcpTasks.kind, "respond_elicitation"),
            ),
          )
          .orderBy(desc(mcpTasks.turn_seq))
          .limit(1);
        if (!row) return null;
        if (row.failure_reason) {
          throw new Error(`resumed MCP task failed: ${row.failure_reason}`);
        }
        return row.result ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "resumed MCP task completion" },
    );
  }

  async function waitForElicitationDeliveryReady(conversationId: string): Promise<void> {
    await waitFor(
      async () => {
        const [turn] = await suite.http.db
          .select({ state: conversationTurns.state })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.tenant_id, suite.http.tenantId),
              eq(conversationTurns.conversation_id, conversationId),
            ),
          )
          .orderBy(desc(conversationTurns.created_at))
          .limit(1);
        return turn?.state === "completed" ? turn : null;
      },
      { tries: 500, sleepMs: 10, label: "native elicitation delivery readiness" },
    );
  }

  test("conversation_get fires elicitation/create, returns input_required immediately, and stages the accept detached", async () => {
    const { conversationId, elicitationId } = await seedPendingPrompt({
      summary: "Choose rollout",
      input: {
        question: "Choose rollout",
        options: [
          { value: "canary", label: "Canary" },
          { value: "full", label: "Full" },
        ],
      },
    });

    const result = await client.callTool({
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
    expect(requests).toBe(1);

    const stored = await waitFor(
      async () => {
        const row = await readElicitationRow(elicitationId);
        return row?.output ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "detached answer staging" },
    );
    expect(stored.protocol_native).toBe(true);
    expect(stored.output).toEqual({ value: "canary", option_index: 0 });
    expect(stored.delivery_attempts).toBe(1);
    await waitForResumedTask(conversationId);
    const resolved = await waitFor(
      async () => {
        const row = await readElicitationRow(elicitationId);
        return row?.status === "resolved" ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "native accept resolution" },
    );
    expect(resolved.status).toBe("resolved");
    const approvals = await waitFor(
      async () => {
        const rows = await listAuditRows(elicitationId, "approval.approved");
        return rows.length > 0 ? rows : null;
      },
      { tries: 500, sleepMs: 10, label: "native accept audit commit" },
    );
    expect(approvals).toHaveLength(1);
  }, 15_000);

  test("a native decline is persisted and audited as a rejection", async () => {
    const declineClient = await suite.connectElicitation(async (request) => {
      expect(request.params.mode).toBe("form");
      return { action: "decline" };
    });
    const { conversationId, elicitationId } = await seedPendingPrompt({
      summary: "Decline rollout",
      input: {
        question: "Decline rollout",
        options: [{ value: "stable", label: "Stable" }],
      },
    });

    const result = await declineClient.callTool({
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

    const stored = await waitFor(
      async () => {
        const row = await readElicitationRow(elicitationId);
        return row?.status === "cancelled" ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "native decline resolution" },
    );
    expect(stored.decision_reason).toBe("user_declined");
    const audit = await waitFor(
      async () => {
        const rows = await listAuditRows(elicitationId, "approval.rejected");
        return rows[0] ?? null;
      },
      { tries: 500, sleepMs: 10, label: "native decline audit commit" },
    );
    expect(audit?.reason).toBe("user_declined");
    await waitForResumedTask(conversationId);
  }, 15_000);

  test("a throwing client handler leaves the row pending and retryable — no destruction, no rejection audit", async () => {
    const failingClient = await suite.connectElicitation(async () => {
      throw new Error("simulated transport break");
    });
    const { conversationId, elicitationId } = await seedPendingPrompt({
      summary: "Transport break rollout",
      input: {
        question: "Transport break rollout",
        options: [{ value: "canary", label: "Canary" }],
      },
    });

    const result = await failingClient.callTool({
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

    const stored = await waitFor(
      async () => {
        const row = await readElicitationRow(elicitationId);
        return row?.delivery_last_error === "transport_failed" ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "transport-failed delivery release" },
    );
    expect(stored.status).toBe("pending");
    expect(stored.output).toBeNull();
    expect(stored.decision_reason).toBeNull();
    expect(stored.delivery_lease_id).toBeNull();
    expect(stored.delivery_lease_expires_at).toBeNull();
    expect(await readConversationStatus(conversationId)).toBe("awaiting_input");
    expect(await listAuditRows(elicitationId, "approval.rejected")).toHaveLength(0);
  }, 15_000);

  test("an instant cancel is a client auto-cancel, not a human decision — row stays pending", async () => {
    const fastCancelClient = await suite.connectElicitation(async () => {
      return { action: "cancel" as const };
    });
    const { conversationId, elicitationId } = await seedPendingPrompt({
      summary: "Fast cancel rollout",
      input: {
        question: "Fast cancel rollout",
        options: [{ value: "canary", label: "Canary" }],
      },
    });

    const result = await fastCancelClient.callTool({
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

    const stored = await waitFor(
      async () => {
        const row = await readElicitationRow(elicitationId);
        return row?.delivery_last_error === "form_fast_cancel" ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "fast-cancel delivery release" },
    );
    expect(stored.status).toBe("pending");
    expect(stored.output).toBeNull();
    expect(stored.decision_reason).toBeNull();
    expect(stored.delivery_lease_id).toBeNull();
    expect(await readConversationStatus(conversationId)).toBe("awaiting_input");
    expect(await listAuditRows(elicitationId, "approval.rejected")).toHaveLength(0);
  }, 15_000);

  test("a client that never answers still gets input_required within the delivery grace", async () => {
    const silentClient = await suite.connectElicitation(() => new Promise(() => {}));
    const { conversationId, elicitationId } = await seedPendingPrompt({
      summary: "Silent rollout",
      input: {
        question: "Silent rollout",
        options: [{ value: "canary", label: "Canary" }],
      },
    });

    const startedAt = Date.now(); // allow-wall-clock
    const result = await silentClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversationId },
    });
    const elapsedMs = Date.now() - startedAt; // allow-wall-clock
    expect(elapsedMs).toBeLessThan(10_000);
    expect(result.isError).toBe(false);
    expect(parseEnvelope(result)).toEqual({
      status: "input_required",
      conversation_id: conversationId,
      phase: "awaiting_human_input",
      pending_elicitation_id: elicitationId,
    });

    const row = await readElicitationRow(elicitationId);
    expect(row?.status).toBe("pending");
    expect(row?.output).toBeNull();
    expect(row?.delivery_lease_id).not.toBeNull();
    expect(await readConversationStatus(conversationId)).toBe("awaiting_input");
  }, 15_000);

  test("tasks/get delivers native input and rearms the same task", async () => {
    let taskRequests = 0;
    const tasksClient = await suite.connectTasksElicitation(async (request) => {
      taskRequests += 1;
      expect(request.params.mode).toBe("form");
      expect(request.params.message).toBe("Approve rollout?");
      return { action: "accept", content: { confirmed: true } };
    });
    const { conversationId, elicitationId, taskId } = await seedPendingPrompt({
      tool_name: "ask_user_confirm",
      summary: "Approve rollout?",
      input: { question: "Approve rollout?" },
    });

    const task = await tasksClient.experimental.tasks.getTask(taskId);

    expect(taskRequests).toBe(1);
    expect(["working", "input_required", "completed"]).toContain(task.status);
    const storedElicitation = await waitFor(
      async () => {
        const row = await readElicitationRow(elicitationId);
        return row?.output ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "tasks/get detached answer staging" },
    );
    expect(storedElicitation.output).toEqual({ confirmed: true });
    await waitForResumedTask(conversationId);
    const taskRows = await suite.http.db
      .select()
      .from(mcpTasks)
      .where(
        and(
          eq(mcpTasks.tenant_id, suite.http.tenantId),
          eq(mcpTasks.conversation_id, conversationId),
        ),
      );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.id).toBe(taskId);
    expect(taskRows[0]?.kind).toBe("respond_elicitation");
  }, 15_000);

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
