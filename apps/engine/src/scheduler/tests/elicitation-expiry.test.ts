// Integration tests for the approval-backed elicitation expiry sweep.
//
// The chat confirm gate mints a `tool_approvals` row (24-hour TTL), an
// `ask_user_confirm` elicitation carrying the approval handle, and parks the
// conversation in `awaiting_input`. When the operator never answers, the
// approval dies on its TTL but the elicitation + conversation strand forever.
// `runElicitationExpiry` reconciles those zombies:
//   - dead approval (expired or already deleted) → elicitation `timeout`,
//     conversation reactivated, tool-call output back-filled, one
//     `elicitation.expired` audit row under the row's tenant
//   - live approval, handle-less prompt, or non-awaiting conversation →
//     untouched / guarded
//
// NOTE on MCP Tasks: an `mcp_tasks` row derives `input_required` from
// exactly two facts — the conversation reads `awaiting_input` AND a pending
// elicitation exists (`mcp/tasks/task-store.ts#derivesInputRequired`). The
// sweep flips both, so `input_required` after the sweep is impossible by
// construction; the conversation-status and elicitation-status assertions
// below cover it without the task-store's turn_seq/task-row scaffolding.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

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
import { runElicitationExpiry } from "../elicitation-expiry-runner.ts";

let srv: HttpTestServer;

const nextUuid = createDeterministicUuidFactory(0xe11c17);

// Approval expiry instants. The sweep compares against Postgres' now(), so
// these only need to be firmly on either side of it.
const expiredAt = new Date(Date.now() - 60_000); // 1 minute ago allow-wall-clock
const liveUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now allow-wall-clock

/** The sweep's `started` instant. A helper so the multi-line call sites below
 *  keep the wall-clock read on one annotated line. */
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

/** Minimal `tool_approvals` row — dummy ciphertext; the sweep only reads
 *  `expires_at`, never decrypts. */
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

/** Pending `ask_user_confirm` row, back-dated past the approval TTL so the
 *  sweep's age prefilter picks it up. Postgres now() arithmetic — one clock. */
async function seedElicitation(p: {
  conversationId: string;
  toolCallId: string | null;
  approvalId: string | null;
  /** Leave unset for an already-expired row (the common case here). Set a future
   *  instant to seed a prompt the sweep must NOT select. */
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
      // The sweep selects on the row's OWN expiry, so seed it explicitly rather
      // than backdating `created_at` and relying on a per-kind re-derivation.
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
      // Mirrors `elicitationExpiry`, which lifts a draft grant's embedded expiry
      // onto the column the sweep selects on.
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
    // The verdict is stated on the row. Without it a transcript rendered
    // the call as completed with a green tick — for work that never ran.
    expect(toolCall?.outcome).toBe("denied");
    expect(toolCall?.confirmation_state).toBe("expired");

    const audits = await expiredAuditRowsFor(elicitationId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.tenant_id).toBe(srv.tenantId);
  });

  test("absent approval row (already pruned): same cascade", async () => {
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    // Handle references an approval that was never inserted — the retention
    // sweep deleted it before this sweep saw the elicitation.
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
    // An ordinary ask_user_confirm a human may legitimately still be answering.
    // Bounded, but nowhere near its bound — the sweep must leave it alone.
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
    // The backstop for a decision whose primary completion was interrupted — an
    // engine restart between the grant and the enqueue, or a lost job
    // (`conversation.run-turn` has retryLimit 0, so nothing else retries it).
    // Before this edge existed the sweep only ever EXPIRED: a person's yes could
    // reach a dead end and then be reported as "the operator did not answer".
    const conversationId = await seedConversation("awaiting_input");
    const toolCallId = await seedToolCall(conversationId);
    const approvalId = nextUuid();
    // Granted, unclaimed, and still inside its claim window.
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
    // Staged for the resumed turn to resolve — emphatically NOT timed out.
    expect(elicitation.status).toBe("pending");
    expect(elicitation.output).toEqual({ confirmed: true });
    expect(await expiredAuditRowsFor(elicitationId)).toHaveLength(0);

    // The row is still pending while the worker runs, so a second tick must not
    // enqueue a second resume for the same decision. Its expiry now rides the
    // approval's claim window.
    await runElicitationExpiry(nowForSweep(), srv.db, {
      resume: async (p) => {
        resumed.push({ elicitation_id: p.elicitation_id });
        return true;
      },
    });
    expect(resumed).toHaveLength(1);
  });

  test("granted but past its claim window: expired, and the loss is audited", async () => {
    // The decision can no longer be acted on. Expiring is correct — staying
    // silent is not: a claim miss reports `confirmation_expired` whether or not a
    // human ever granted, and it writes no audit row, which is why production
    // lost five approvals without a trace.
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
    // Regression for the 60 conversations found wedged in `awaiting_input` in
    // production — the oldest for two and a half months. None carried an approval
    // handle or a draft-credential kind, so the old kind-derived selection could
    // never see them, and each kept deriving `input_required` on every MCP Tasks
    // poll. A prompt nobody will ever answer must not hold a session hostage.
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
    expect(await readConversationStatus(conversationId)).toBe("active");
  });
});

describe("runElicitationExpiry — guarded conversation flip", () => {
  test("conversation no longer awaiting_input: elicitation resolves, conversation status unchanged", async () => {
    // A conversation that moved on (committed) after the elicitation was
    // opened. The sweep must still time out the zombie elicitation but the
    // guarded flip must NOT resurrect the conversation to active.
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
