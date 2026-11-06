import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { mcpTasks } from "../../db/schema/index.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import {
  client,
  listAuditRows,
  parseEnvelope,
  readConversationStatus,
  readElicitationRow,
  requests,
  seedPendingPrompt,
  setupNativeElicitationSuite,
  suite,
  waitForResumedTask,
} from "./conversation-native-elicitation-fixtures.ts";

describe("MCP conversation native elicitation — real Streamable HTTP", () => {
  setupNativeElicitationSuite();

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
});
