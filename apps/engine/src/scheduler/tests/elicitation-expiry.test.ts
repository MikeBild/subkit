import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { runElicitationExpiry } from "../../conversations/scheduled/elicitation-expiry-runner.ts";
import {
  auditLog,
  conversationElicitations,
  conversations,
  conversationToolCalls,
  mcpTasks,
  toolApprovals,
} from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { handleConversationTool } from "../../mcp/capabilities/conversations.ts";
import { ConversationTaskStore } from "../../mcp/tasks/task-store.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";

let srv: HttpTestServer;

const nextUuid = createDeterministicUuidFactory(0xe11c17);

const expiredAt = new Date(Date.now() - 60_000); // 1 minute ago allow-wall-clock
const liveUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now allow-wall-clock

const nowForSweep = (): Date => new Date(); // allow-wall-clock

type ConversationStatus = "active" | "awaiting_input" | "committed" | "abandoned";

async function seedConversation(status: ConversationStatus): Promise<string> {
  const [row] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status })
    .returning();
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

async function seedToolCall(conversationId: string, tool = "wf_send_report"): Promise<string> {
  const [row] = await srv.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: conversationId,
      tool,
      input: { to: "ops@example.com" },
    })
    .returning();
  if (!row) throw new Error("seed tool call failed");
  return row.id;
}

async function seedApproval(
  id: string,
  expiresAt: Date,
  decision?: { granted_at?: Date; declined_at?: Date; consumed_at?: Date },
): Promise<void> {
  await srv.db.insert(toolApprovals).values({
    id,
    tenant_id: srv.tenantId,
    principal_id: srv.userId,
    tool: "wf_send_report",
    surface: "chat",
    args_ciphertext: new Uint8Array([1, 2, 3]),
    args_iv: new Uint8Array([4, 5, 6]),
    args_auth_tag: new Uint8Array([7, 8, 9]),
    args_hash: `hash-${id}`,
    expires_at: expiresAt,
    ...(decision?.granted_at ? { granted_at: decision.granted_at, granted_via: "portal" } : {}),
    ...(decision?.declined_at ? { declined_at: decision.declined_at } : {}),
    ...(decision?.consumed_at ? { consumed_at: decision.consumed_at } : {}),
  });
}

async function seedElicitation(p: {
  conversationId: string;
  toolCallId: string | null;
  approvalId: string | null;
  expiresAt?: Date;
}): Promise<string> {
  const input = p.approvalId
    ? {
        kind: "confirm",
        commit_intent: {
          kind: "execute_confirmed_tool_call",
          payload: { tool: "wf_send_report", approval_id: p.approvalId },
          description: "Send the weekly report",
        },
      }
    : { kind: "confirm", message: "Proceed with the plan?" };
  const [row] = await srv.db
    .insert(conversationElicitations)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: p.conversationId,
      tool_call_id: p.toolCallId,
      tool_name: "ask_user_confirm",
      summary: "Send the weekly report",
      input,
      status: "pending",
      expires_at: p.expiresAt ?? new Date(Date.now() - 5 * 60_000), // allow-wall-clock
    })
    .returning();
  if (!row) throw new Error("seed elicitation failed");
  await srv.db.execute(
    `UPDATE conversation_elicitations SET created_at = now() - interval '20 minutes' WHERE id = '${row.id}'`,
  );
  return row.id;
}

async function seedDraftCredentialElicitation(p: {
  conversationId: string;
  toolCallId: string;
  expiresAt: Date;
}): Promise<string> {
  const [row] = await srv.db
    .insert(conversationElicitations)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: p.conversationId,
      tool_call_id: p.toolCallId,
      tool_name: "ask_user_form",
      summary: "Enter the credential for Cloudflare PROD",
      input: {
        kind: "connector_draft_credential_setup",
        auth_type: "bearer",
        connector_slug: "cloudflare",
        setup_url: `https://engine.invalid/v1/connector-drafts/${p.conversationId}/credentials/setup?grant=canary`,
        expires_at: p.expiresAt.toISOString(),
      },
      status: "pending",
      expires_at: p.expiresAt,
    })
    .returning();
  if (!row) throw new Error("seed draft credential elicitation failed");
  await srv.db.execute(
    `UPDATE conversation_elicitations SET created_at = now() - interval '20 minutes' WHERE id = '${row.id}'`,
  );
  return row.id;
}

async function seedCompletedMcpTask(
  conversationId: string,
  elicitationId: string,
): Promise<string> {
  const setupUrl =
    `https://engine.invalid/v1/connector-drafts/${conversationId}` +
    "/credentials/setup?grant=canary";
  const [row] = await srv.db
    .insert(mcpTasks)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: conversationId,
      turn_seq: 1,
      kind: "start",
      actor_id: srv.userId,
      actor_kind: "user",
      request_source: "mcp",
      result: {
        conversation_id: conversationId,
        status: "awaiting_input",
        pending_elicitation_id: elicitationId,
        events: [
          {
            type: "tool_result",
            output: { status: "awaiting_input", elicitation_id: elicitationId },
          },
          {
            type: "elicit_request",
            elicitation_id: elicitationId,
            input: { kind: "connector_draft_credential_setup", setup_url: setupUrl },
          },
          { type: "completed", status: "awaiting_input" },
          { type: "next_suggestion", suggestion: "retry ask_user_form" },
        ],
      },
    })
    .returning();
  if (!row) throw new Error("seed mcp task failed");
  return row.id;
}

async function readElicitation(id: string) {
  const [row] = await srv.db
    .select()
    .from(conversationElicitations)
    .where(eq(conversationElicitations.id, id))
    .limit(1);
  if (!row) throw new Error(`elicitation not found: ${id}`);
  return row;
}

async function readConversationStatus(id: string): Promise<string> {
  const [row] = await srv.db
    .select({ status: conversations.status })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (!row) throw new Error(`conversation not found: ${id}`);
  return row.status;
}

async function expiredAuditRowsFor(elicitationId: string) {
  return srv.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.action, "elicitation.expired"), eq(auditLog.resource_id, elicitationId)),
    );
}

beforeAll(async () => {
  srv = await createHttpTestServer("elicitation-expiry");
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("runElicitationExpiry — dead approval cascade", () => {
  test("expired approval row: elicitation → timeout, conversation reactivated, tool call back-filled, audit written", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    const approvalId = nextUuid();
    await seedApproval(approvalId, expiredAt);
    const elicitationId = await seedElicitation({ conversationId, toolCallId, approvalId });

    await runElicitationExpiry(new Date(), srv.db); // allow-wall-clock

    const elicitation = await readElicitation(elicitationId);
    expect(elicitation.status).toBe("timeout");
    expect(elicitation.decision_reason).toBe("approval_expired");
    expect(elicitation.decided_by).toBeNull();
    expect(elicitation.decided_by_kind).toBeNull();

    expect(await readConversationStatus(conversationId)).toBe("active");

    const [toolCall] = await srv.db
      .select({
        output: conversationToolCalls.output,
        outcome: conversationToolCalls.outcome,
        confirmation_state: conversationToolCalls.confirmation_state,
      })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.id, toolCallId))
      .limit(1);
    const output = toolCall?.output as Record<string, unknown>;
    expect(output.ok).toBe(false);
    expect(output.abandoned).toBe(true);
    expect(output.reason).toBe("approval_expired");
    expect(String(output.note)).toContain("nothing ran");
    expect(toolCall?.outcome).toBe("expired");
    expect(toolCall?.confirmation_state).toBe("expired");

    const audits = await expiredAuditRowsFor(elicitationId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.tenant_id).toBe(srv.tenantId);
  });

  test("absent approval row (already pruned): same cascade", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    const elicitationId = await seedElicitation({
      conversationId,
      toolCallId,
      approvalId: nextUuid(),
    });

    await runElicitationExpiry(new Date(), srv.db); // allow-wall-clock

    const elicitation = await readElicitation(elicitationId);
    expect(elicitation.status).toBe("timeout");
    expect(elicitation.decision_reason).toBe("approval_expired");
    expect(await readConversationStatus(conversationId)).toBe("active");
    expect(await expiredAuditRowsFor(elicitationId)).toHaveLength(1);
  });
});

describe("runElicitationExpiry — expired draft credential setup", () => {
  test("expired grant unstrands both conversation_get and MCP Tasks state", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId, "ask_user_form");
    const elicitationId = await seedDraftCredentialElicitation({
      conversationId,
      toolCallId,
      expiresAt: expiredAt,
    });
    const taskId = await seedCompletedMcpTask(conversationId, elicitationId);
    const store = new ConversationTaskStore({ db: srv.db, tenant_id: srv.tenantId });
    const principal = {
      kind: "user" as const,
      id: srv.userId,
      tenant_id: srv.tenantId,
      provider: "api_key" as const,
      roles: ["admin"],
    };

    expect((await store.getTask(taskId))?.status).toBe("input_required");
    const before = await handleConversationTool({
      db: srv.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conversationId },
    });
    const beforeBody = JSON.parse(before.content[0]?.text ?? "{}") as { status?: string };
    expect(beforeBody.status).toBe("input_required");

    await runElicitationExpiry(new Date(), srv.db); // allow-wall-clock

    const elicitation = await readElicitation(elicitationId);
    expect(elicitation.status).toBe("timeout");
    expect(elicitation.decision_reason).toBe("credential_setup_expired");
    expect(elicitation.decided_by).toBeNull();
    expect(elicitation.decided_by_kind).toBeNull();
    expect(await readConversationStatus(conversationId)).toBe("active");
    expect((await store.getTask(taskId))?.status).toBe("completed");
    const after = await handleConversationTool({
      db: srv.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conversationId },
    });
    const afterBody = JSON.parse(after.content[0]?.text ?? "{}") as {
      status?: string;
      result?: { status?: string; pending_elicitation_id?: string; events?: unknown[] };
    };
    expect(afterBody.status).toBe("completed");
    expect(afterBody.result?.status).toBe("active");
    expect(afterBody.result?.pending_elicitation_id).toBeUndefined();
    expect(
      afterBody.result?.events?.some((event) => {
        return (event as { type?: string }).type === "elicit_request";
      }),
    ).toBe(false);
    expect(JSON.stringify(afterBody)).not.toContain("credentials/setup?grant=");

    const taskResult = (await store.getTaskResult(taskId)) as {
      content: Array<{ type: string; text: string }>;
    };
    const taskBody = JSON.parse(taskResult.content[0]?.text ?? "{}") as {
      status?: string;
      pending_elicitation_id?: string;
    };
    expect(taskBody.status).toBe("active");
    expect(taskBody.pending_elicitation_id).toBeUndefined();
    expect(JSON.stringify(taskBody)).not.toContain("credentials/setup?grant=");

    const [toolCall] = await srv.db
      .select({ output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.id, toolCallId))
      .limit(1);
    const output = toolCall?.output as Record<string, unknown>;
    expect(output.ok).toBe(false);
    expect(output.abandoned).toBe(true);
    expect(output.reason).toBe("credential_setup_expired");
    expect(String(output.note)).toContain("no credential was stored");

    const audits = await expiredAuditRowsFor(elicitationId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toBe("credential_setup_expired");
  });

  test("unexpired draft grant stays pending even when its row is old", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId, "ask_user_form");
    const elicitationId = await seedDraftCredentialElicitation({
      conversationId,
      toolCallId,
      expiresAt: liveUntil,
    });

    await runElicitationExpiry(new Date(), srv.db); // allow-wall-clock

    expect((await readElicitation(elicitationId)).status).toBe("pending");
    expect(await readConversationStatus(conversationId)).toBe("awaiting_input");
    expect(await expiredAuditRowsFor(elicitationId)).toHaveLength(0);
  });
});

describe("runElicitationExpiry — rows the sweep must not touch", () => {
  test("live approval: elicitation stays pending, conversation stays awaiting_input", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    const approvalId = nextUuid();
    await seedApproval(approvalId, liveUntil);
    const elicitationId = await seedElicitation({ conversationId, toolCallId, approvalId });

    await runElicitationExpiry(new Date(), srv.db); // allow-wall-clock

    const elicitation = await readElicitation(elicitationId);
    expect(elicitation.status).toBe("pending");
    expect(await readConversationStatus(conversationId)).toBe("awaiting_input");
    expect(await expiredAuditRowsFor(elicitationId)).toHaveLength(0);
  });

  test("plain prompt still inside its window: untouched", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    const elicitationId = await seedElicitation({
      conversationId,
      toolCallId,
      approvalId: null,
      expiresAt: liveUntil,
    });

    await runElicitationExpiry(new Date(), srv.db); // allow-wall-clock

    const elicitation = await readElicitation(elicitationId);
    expect(elicitation.status).toBe("pending");
    expect(await readConversationStatus(conversationId)).toBe("awaiting_input");
  });
});

describe("runElicitationExpiry — a granted approval is completed, not expired", () => {
  test("granted but unclaimed: the sweep resumes the turn instead of timing it out", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    const approvalId = nextUuid();
    await seedApproval(approvalId, liveUntil, { granted_at: new Date(Date.now() - 60_000) }); // allow-wall-clock
    const elicitationId = await seedElicitation({ conversationId, toolCallId, approvalId });

    const resumed: Array<{ elicitation_id: string }> = [];
    await runElicitationExpiry(nowForSweep(), srv.db, {
      resume: async (p) => {
        resumed.push({ elicitation_id: p.elicitation_id });
        return true;
      },
    });

    expect(resumed).toEqual([{ elicitation_id: elicitationId }]);
    const elicitation = await readElicitation(elicitationId);
    expect(elicitation.status).toBe("pending");
    expect(elicitation.output).toEqual({ confirmed: true });
    expect(await expiredAuditRowsFor(elicitationId)).toHaveLength(0);

    await runElicitationExpiry(nowForSweep(), srv.db, {
      resume: async (p) => {
        resumed.push({ elicitation_id: p.elicitation_id });
        return true;
      },
    });
    expect(resumed).toHaveLength(1);
  });

  test("granted but past its claim window: expired, and the loss is audited", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    const approvalId = nextUuid();
    await seedApproval(approvalId, expiredAt, { granted_at: new Date(Date.now() - 60_000) }); // allow-wall-clock
    const elicitationId = await seedElicitation({ conversationId, toolCallId, approvalId });

    await runElicitationExpiry(nowForSweep(), srv.db, {
      resume: async () => true,
    });

    const elicitation = await readElicitation(elicitationId);
    expect(elicitation.status).toBe("timeout");
    expect(await readConversationStatus(conversationId)).toBe("active");
    const abandoned = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "approval.grant_abandoned"),
          eq(auditLog.resource_id, approvalId),
        ),
      );
    expect(abandoned).toHaveLength(1);
  });

  test("declined: expired without ever being resumed", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    const approvalId = nextUuid();
    await seedApproval(approvalId, expiredAt, { declined_at: new Date(Date.now() - 60_000) }); // allow-wall-clock
    const elicitationId = await seedElicitation({ conversationId, toolCallId, approvalId });

    const resumed: string[] = [];
    await runElicitationExpiry(nowForSweep(), srv.db, {
      resume: async (p) => {
        resumed.push(p.elicitation_id);
        return true;
      },
    });

    expect(resumed).toHaveLength(0);
    expect((await readElicitation(elicitationId)).status).toBe("timeout");
  });
});

describe("runElicitationExpiry — plain prompts are bounded too", () => {
  test("an ordinary ask_user_confirm past its expiry is swept and its conversation reactivated", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    const elicitationId = await seedElicitation({
      conversationId,
      toolCallId,
      approvalId: null,
    });

    await runElicitationExpiry(new Date(), srv.db); // allow-wall-clock

    const elicitation = await readElicitation(elicitationId);
    expect(elicitation.status).toBe("timeout");
    expect(elicitation.decision_reason).toBe("prompt_expired");
    expect(elicitation.decided_by).toBeNull();
    expect(elicitation.decided_by_kind).toBeNull();
    expect(await readConversationStatus(conversationId)).toBe("active");
  });
});

describe("runElicitationExpiry — guarded conversation flip", () => {
  test("conversation no longer awaiting_input: elicitation resolves, conversation status unchanged", async () => {
    const conversationId = await seedConversation("committed");
    const toolCallId = await seedToolCall(conversationId);
    const approvalId = nextUuid();
    await seedApproval(approvalId, expiredAt);
    const elicitationId = await seedElicitation({ conversationId, toolCallId, approvalId });

    await runElicitationExpiry(new Date(), srv.db); // allow-wall-clock

    const elicitation = await readElicitation(elicitationId);
    expect(elicitation.status).toBe("timeout");
    expect(await readConversationStatus(conversationId)).toBe("committed");
  });
});

describe("runElicitationExpiry — idempotence", () => {
  test("second sweep is a no-op: no second audit row, decision timestamp unchanged", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    const approvalId = nextUuid();
    await seedApproval(approvalId, expiredAt);
    const elicitationId = await seedElicitation({ conversationId, toolCallId, approvalId });

    await runElicitationExpiry(new Date(), srv.db); // allow-wall-clock
    const first = await readElicitation(elicitationId);
    expect(first.status).toBe("timeout");

    await runElicitationExpiry(new Date(), srv.db); // allow-wall-clock

    const second = await readElicitation(elicitationId);
    expect(second.status).toBe("timeout");
    expect(second.decided_at?.toISOString()).toBe(first.decided_at?.toISOString() ?? "missing");
    expect(await readConversationStatus(conversationId)).toBe("active");
    expect(await expiredAuditRowsFor(elicitationId)).toHaveLength(1);
  });
});
