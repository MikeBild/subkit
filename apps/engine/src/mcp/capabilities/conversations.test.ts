// MCP conversation tool handlers — async Tasks fast-return contract.
//
// Pins SEP-1686 step 7:
//   - the three turn-driving tools return a fast `working` status and
//     never run the model loop inline,
//   - a Tasks-capable call (`taskAugmented: true`) returns a
//     `CreateTaskResult`,
//   - a non-Tasks call returns a plain `CallToolResult` text body that
//     steers the client to `conversation_get`,
//   - each call inserts exactly one `mcp_tasks` row + enqueues a job.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig, loadConfig } from "../../config/loader.ts";
import { withWorkflowPersisted } from "../../conversations/authoring-state.ts";
import { appendSnapshot } from "../../conversations/draft.ts";
import type { DraftDocument } from "../../conversations/types.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
  mcpTasks,
  tenants,
  users,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { startBoss, stopBoss } from "../../queue/index.ts";
import { stampMcpTaskProgress } from "../tasks/store.ts";
import { handleConversationTool } from "./conversations.ts";

let testDb: TestDb;
let principal: ResolvedPrincipal;
let foreignPrincipal: ResolvedPrincipal;

async function ensureConfig(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    // not loaded
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-convtool-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/convtool-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  await ensureConfig();
  resetMockProvider();
  testDb = await createTestDb("mcp_conv_tool");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-convtool", display_name: "ConvTool" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  const [u] = await testDb.db
    .insert(users)
    .values({ tenant_id: t.id, email: "ct@test.local", role: "admin" })
    .returning();
  if (!u) throw new Error("seed user failed");
  principal = {
    kind: "user",
    id: u.id,
    tenant_id: t.id,
    provider: "api_key",
    roles: ["admin"],
  };
  // A second tenant — used for the cross-tenant negative tests.
  const [t2] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-convtool-foreign", display_name: "ConvTool Foreign" })
    .returning();
  if (!t2) throw new Error("seed foreign tenant failed");
  const [u2] = await testDb.db
    .insert(users)
    .values({ tenant_id: t2.id, email: "foreign@test.local", role: "admin" })
    .returning();
  if (!u2) throw new Error("seed foreign user failed");
  foreignPrincipal = {
    kind: "user",
    id: u2.id,
    tenant_id: t2.id,
    provider: "api_key",
    roles: ["admin"],
  };
  // The handler enqueues a `conversation.run-turn` job via getBoss().
  // No worker is registered — the job sits in the queue; this suite
  // only asserts the fast-return shape, not the turn outcome.
  await startBoss({ connectionString: testDb.url });
});

afterAll(async () => {
  await stopBoss(5_000);
  await testDb.cleanup();
});

describe("conversation_start", () => {
  test("non-Tasks client → fast plain working body steering to conversation_get", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    expect(result.isError).toBe(false);
    expect(result.createTaskResult).toBeUndefined();
    const body = JSON.parse(result.content[0]?.text ?? "{}") as {
      status: string;
      poll_with: string;
      conversation_id: string;
      mcp_task_id: string;
    };
    expect(body.status).toBe("working");
    expect(body.poll_with).toBe("conversation_get");
    expect(body.conversation_id.length).toBeGreaterThan(0);
    expect(body.mcp_task_id.length).toBeGreaterThan(0);

    // Exactly one conversation row + one mcp_tasks row were created.
    const [conv] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, body.conversation_id));
    expect(conv).toBeTruthy();
    const taskRows = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, body.conversation_id));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.kind).toBe("start");
    // The job was enqueued — job_id is recorded on the row.
    expect(taskRows[0]?.job_id).toBeTruthy();
  });

  test("Tasks-capable client → CreateTaskResult with status working", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
      taskAugmented: true,
    });
    expect(result.isError).toBe(false);
    expect(result.createTaskResult).toBeTruthy();
    const task = result.createTaskResult?.task;
    expect(task?.status).toBe("working");
    expect(task?.taskId.length).toBeGreaterThan(0);
    expect(typeof task?.ttl).toBe("number");
    expect(typeof task?.pollInterval).toBe("number");
  });
});

describe("conversation_start — slug idempotency (resume, not duplicate)", () => {
  test("a second start naming the same slug resumes the first conversation", async () => {
    const message = "create workflow load-jira-issue-full-details";
    const first = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message },
    });
    expect(first.isError).toBe(false);
    const firstBody = JSON.parse(first.content[0]?.text ?? "{}") as {
      conversation_id: string;
      resumed?: boolean;
    };
    expect(firstBody.resumed).toBeUndefined();
    expect(firstBody.conversation_id.length).toBeGreaterThan(0);

    const second = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message },
    });
    expect(second.isError).toBe(false);
    const secondBody = JSON.parse(second.content[0]?.text ?? "{}") as {
      conversation_id: string;
      resumed?: boolean;
    };
    expect(secondBody.resumed).toBe(true);
    expect(secondBody.conversation_id).toBe(firstBody.conversation_id);

    // No duplicate conversation — but the resumed start APPENDS the
    // incoming message and enqueues a turn for it (a resume that swallows
    // the message would leave the client polling a conversation that
    // never moves): one `start` task plus one `append` task.
    const tasks = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, firstBody.conversation_id));
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.kind).sort()).toEqual(["append", "start"]);
    expect(tasks.every((t) => t.job_id)).toBe(true);
  });

  test("a terminal (committed) conversation is not resumed — a fresh one is created", async () => {
    const slug = "sync-committed-orders-nightly";
    const message = `create workflow ${slug}`;
    // Seed a committed conversation whose opening message names the slug.
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        draft: { workflow: { name: "Sync Committed Orders Nightly", slug, steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");

    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message },
    });
    expect(started.isError).toBe(false);
    const body = JSON.parse(started.content[0]?.text ?? "{}") as {
      conversation_id: string;
      resumed?: boolean;
    };
    expect(body.resumed).toBeUndefined();
    expect(body.conversation_id).not.toBe(conv.id);
  });

  test("a different slug creates a new conversation, not a resume", async () => {
    const first = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "create workflow export-hubspot-contacts-daily" },
    });
    const firstBody = JSON.parse(first.content[0]?.text ?? "{}") as { conversation_id: string };

    const second = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "create workflow import-stripe-invoices-hourly" },
    });
    const secondBody = JSON.parse(second.content[0]?.text ?? "{}") as {
      conversation_id: string;
      resumed?: boolean;
    };
    expect(secondBody.resumed).toBeUndefined();
    expect(secondBody.conversation_id).not.toBe(firstBody.conversation_id);
  });

  test("shared prose compounds (German hyphenated words) never resume — only authored slugs do", async () => {
    // Regression: `extractSlugTokens` sees German compounds like
    // `http-connector` / `api-key` as kebab tokens. Matching them against
    // the candidate's opening-message PROSE funnelled every later start
    // that shared one compound into an unrelated stuck conversation
    // (observed live). Prose overlap must not resume.
    const first = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: {
        message:
          "Lege einen neuen HTTP-Connector für die TrustMRR-API an. Authentifizierung: Bearer Token im Authorization-Header.",
      },
    });
    const firstBody = JSON.parse(first.content[0]?.text ?? "{}") as { conversation_id: string };

    const second = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: {
        message:
          "Baue vier Workflows für den Opportunity-Radar. Nutze dafür den bestehenden HTTP-Connector mit dem API-Key.",
      },
    });
    expect(second.isError).toBe(false);
    const secondBody = JSON.parse(second.content[0]?.text ?? "{}") as {
      conversation_id: string;
      resumed?: boolean;
    };
    expect(secondBody.resumed).toBeUndefined();
    expect(secondBody.conversation_id).not.toBe(firstBody.conversation_id);
  });

  test("naming the candidate's authored draft slug resumes AND runs the message as a turn", async () => {
    const slug = "radar-sync-weekly-digest";
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "active",
        draft: { workflow: { name: "Radar Sync Weekly Digest", slug, steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");

    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: `bitte ${slug} fertigstellen und speichern` },
    });
    expect(started.isError).toBe(false);
    const body = JSON.parse(started.content[0]?.text ?? "{}") as {
      conversation_id: string;
      resumed?: boolean;
      status: string;
    };
    expect(body.resumed).toBe(true);
    expect(body.conversation_id).toBe(conv.id);
    expect(body.status).toBe("working");

    // The incoming message was persisted into the resumed conversation
    // and a turn was enqueued for it — nothing swallowed.
    const tasks = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conv.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.kind).toBe("append");
    expect(tasks[0]?.job_id).toBeTruthy();
  });
});

describe("conversation_append", () => {
  test("non-Tasks client → fast working body, second mcp_tasks row", async () => {
    // Seed a conversation via the start handler.
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    const appended = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_append",
      args: { conversation_id, message: "another message" },
    });
    expect(appended.isError).toBe(false);
    const body = JSON.parse(appended.content[0]?.text ?? "{}") as { status: string };
    expect(body.status).toBe("working");
    const taskRows = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conversation_id));
    expect(taskRows.length).toBe(2);
  });
});

describe("conversation_respond_elicitation", () => {
  test("non-Tasks client → fast working body for a respond_elicitation turn", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    // Seed a real pending elicitation — the handler stages the answer
    // onto it before enqueue, so the row must exist and be `pending`.
    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "confirm proceed",
        input: { kind: "generic" },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    const responded = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_respond_elicitation",
      args: {
        conversation_id,
        elicitation_id: elicitation.id,
        output: { confirmed: true },
      },
    });
    expect(responded.isError).toBe(false);
    const body = JSON.parse(responded.content[0]?.text ?? "{}") as {
      status: string;
      mcp_task_id: string;
    };
    expect(body.status).toBe("working");
    const [row] = await testDb.db
      .select({ kind: mcpTasks.kind })
      .from(mcpTasks)
      .where(eq(mcpTasks.id, body.mcp_task_id));
    expect(row?.kind).toBe("respond_elicitation");

    // S3: the answer was staged onto the elicitation row's `output`
    // BEFORE enqueue — the job envelope carries no payload body. The
    // row stays `pending` so the worker still drives the real resolve.
    const [staged] = await testDb.db
      .select({ output: conversationElicitations.output, status: conversationElicitations.status })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(staged?.status).toBe("pending");
    expect(staged?.output).toEqual({ confirmed: true });
  });

  test("conversation_get passes the password/sensitive form markers through so the client can mask (#304)", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "set up the connector" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    // A pending credential form: the client renders these markers to mask
    // the secret field. `conversation_get` must relay them verbatim — the
    // "advertise the secret input mode" half of #304 for poll-based clients.
    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_name: "ask_user_form",
        summary: "Enter API credentials",
        input: {
          kind: "ask_user_form",
          fields: [
            { name: "base_url", label: "Base URL", type: "text" },
            { name: "api_token", label: "API token", type: "password", sensitive: true },
          ],
        },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    // Move the conversation into awaiting_input so conversation_get reports
    // the pending form (mirrors the pause path).
    await testDb.db
      .update(conversations)
      .set({ status: "awaiting_input" })
      .where(eq(conversations.id, conversation_id));

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
    });
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      input?: { fields?: Array<{ name: string; type: string; sensitive?: boolean }> };
    };
    expect(body.status).toBe("input_required");
    const tokenField = body.input?.fields?.find((f) => f.name === "api_token");
    expect(tokenField?.type).toBe("password");
    expect(tokenField?.sensitive).toBe(true);
  });

  test("respond_elicitation against a non-existent elicitation → error, no orphan task", async () => {
    // The handler stages the answer onto the elicitation row before
    // enqueue; a missing row must surface a structured error rather
    // than enqueue a job that can never resolve (S3/S4 root cause).
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    const responded = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_respond_elicitation",
      args: {
        conversation_id,
        elicitation_id: "00000000-0000-0000-0000-000000000000",
        output: { confirmed: true },
      },
    });
    expect(responded.isError).toBe(true);
    expect(responded.content[0]?.text).toContain("elicitation not found");
  });

  test("refuses an elicitation whose commit_intent carries an approval_id — a model cannot grant a human's approval", async () => {
    // AN APPROVAL IS GRANTED BY A HUMAN, NEVER BY A MODEL (see tools/approval.ts).
    // An elicitation whose commit_intent names an approval_id IS a person's
    // pending decision, not a question the model may answer on their behalf —
    // see `refuseApprovalElicitation` in ./conversations.ts.
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    const approvalId = "11111111-2222-3333-4444-555555555555";
    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "Approve the held write?",
        input: {
          kind: "generic",
          commit_intent: {
            kind: "execute_confirmed_tool_call",
            payload: { tool: "wf_post_ledger_entries", approval_id: approvalId },
            description: "Post the ledger entries",
          },
        },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    const tasksBefore = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conversation_id));

    const responded = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_respond_elicitation",
      args: {
        conversation_id,
        elicitation_id: elicitation.id,
        output: { confirmed: true },
      },
    });
    expect(responded.isError).toBe(true);
    const body = JSON.parse(responded.content[0]?.text ?? "{}") as {
      status: string;
      error_code: string;
      approval_id: string;
      message: string;
      approval_url?: string;
      approval_window: string;
    };
    expect(body.status).toBe("cannot_help");
    expect(body.error_code).toBe("approval_requires_human");
    expect(body.approval_id).toBe(approvalId);
    // This row carries no link, so the refusal must not invent one.
    expect(body.approval_url).toBeUndefined();
    expect(body.message).not.toContain("http");
    // …and it must not send an MCP client to a "chat UI" that does not exist for
    // it. The window stays stated, in its own field.
    expect(body.message).not.toContain("chat UI");
    expect(body.approval_window).toContain("expire 15 minutes after they are raised");

    // Nothing was resolved: the row is still pending, with no output staged —
    // the refusal happens BEFORE stageElicitationAnswer would touch it.
    const [row] = await testDb.db
      .select({ status: conversationElicitations.status, output: conversationElicitations.output })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(row?.status).toBe("pending");
    expect(row?.output).toBeNull();

    // And no turn was enqueued for it — the refusal never reaches backgroundTurn.
    const tasksAfter = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conversation_id));
    expect(tasksAfter).toHaveLength(tasksBefore.length);
  });

  test("when the confirm carries an approval_url, the refusal hands it over instead of dead-ending", async () => {
    // The refusal is correct — a model may not grant — but it used to send every
    // caller to "the chat UI where it was raised", which for an MCP client is
    // nowhere. That is how a hosted client ended up reporting a dead end while a
    // perfectly good browser link sat unused in the row. The refusal must name
    // the channel the human can actually use, and say that the run continues on
    // its own afterwards so the model does not try to relay the answer back.
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    const approvalId = "22222222-3333-4444-5555-666666666666";
    const approvalUrl = "https://engine.example.test/v1/tool-approvals/decide?grant=skag_probe";
    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "Approve the held write?",
        input: {
          kind: "external_write",
          approval_url: approvalUrl,
          commit_intent: {
            kind: "execute_confirmed_tool_call",
            payload: { tool: "wf_post_ledger_entries", approval_id: approvalId },
            description: "Post the ledger entries",
          },
        },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    const responded = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_respond_elicitation",
      args: { conversation_id, elicitation_id: elicitation.id, output: { confirmed: true } },
    });

    expect(responded.isError).toBe(true);
    const body = JSON.parse(responded.content[0]?.text ?? "{}") as {
      error_code: string;
      approval_url?: string;
      message: string;
    };
    expect(body.error_code).toBe("approval_requires_human");
    expect(body.approval_url).toBe(approvalUrl);
    expect(body.message).toContain("approval_url");
    expect(body.message).toContain("carries out the held call on its own");
    expect(body.message).not.toContain("chat UI");

    // Still refused: nothing resolved, nothing staged.
    const [row] = await testDb.db
      .select({ status: conversationElicitations.status, output: conversationElicitations.output })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(row?.status).toBe("pending");
    expect(row?.output).toBeNull();
  });

  test("an ordinary ask_user_confirm elicitation (no approval handle) is still model-resolvable", async () => {
    // Guards against an over-broad refusal: only a commit_intent carrying
    // `approval_id` is refused. A plain confirm — no commit_intent at all —
    // must keep resolving through the normal path.
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "proceed?",
        input: { kind: "generic" },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    const responded = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_respond_elicitation",
      args: {
        conversation_id,
        elicitation_id: elicitation.id,
        output: { confirmed: true },
      },
    });
    expect(responded.isError).toBe(false);
    const body = JSON.parse(responded.content[0]?.text ?? "{}") as { status: string };
    expect(body.status).toBe("working");
  });
});

describe("validation", () => {
  test("conversation_start without a message → error", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: {},
    });
    expect(result.isError).toBe(true);
  });

  test("conversation_append without conversation_id → error", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_append",
      args: { message: "hi" },
    });
    expect(result.isError).toBe(true);
  });

  test("conversation_get without conversation_id → error", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: {},
    });
    expect(result.isError).toBe(true);
  });

  test("unknown conversation tool name → error", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_does_not_exist",
      args: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unknown conversation tool");
  });
});

describe("conversation_get — tenant isolation", () => {
  test("a foreign tenant polling another tenant's conversation gets conversation-not-found", async () => {
    // Tenant A starts a conversation.
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversationId = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    // Tenant B polls the same conversation id. `conversation_get`
    // resolves the conversation tenant-scoped — a foreign tenant must
    // not see it.
    const foreignGet = await handleConversationTool({
      db: testDb.db,
      principal: foreignPrincipal,
      name: "conversation_get",
      args: { conversation_id: conversationId },
    });
    expect(foreignGet.isError).toBe(true);
    expect(foreignGet.content[0]?.text).toContain("conversation not found");

    // The owning tenant still sees it.
    const ownerGet = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conversationId },
    });
    expect(ownerGet.isError).toBe(false);
  });

  test("conversation_get for a non-existent conversation id → error", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: "00000000-0000-0000-0000-000000000000" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("conversation not found");
  });

  test("a foreign tenant cannot append to another tenant's conversation", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversationId = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    const foreignAppend = await handleConversationTool({
      db: testDb.db,
      principal: foreignPrincipal,
      name: "conversation_append",
      args: { conversation_id: conversationId, message: "intrude" },
    });
    expect(foreignAppend.isError).toBe(true);
    // No mcp_tasks row leaked to the foreign tenant.
    const foreignTasks = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.tenant_id, foreignPrincipal.tenant_id));
    expect(foreignTasks).toHaveLength(0);
  });
});

describe("conversation_get — derived status before any task settles", () => {
  test("a fresh backgrounded turn reports working until the worker runs", async () => {
    // No worker is registered in this suite — the job sits queued.
    // `conversation_get` must report `working` (the task row exists but
    // has neither result nor failure nor cancel).
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversationId = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conversationId },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as { status: string };
    expect(body.status).toBe("working");
  });

  test("a settled no-op save turn reports completed without committed_workflow_id", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "active",
        draft: {},
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "respond_elicitation",
      actor_id: principal.id,
      request_source: "mcp",
      result: {
        conversation_id: conv.id,
        status: "active",
        events: [
          {
            type: "tool_result",
            tool: "save_workflow_draft",
            output: {
              ok: true,
              data: {
                already_persisted: true,
                version_changed: false,
                workflow_id: "wf_existing",
              },
            },
          },
        ],
      },
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      committed_workflow_id?: string;
      result?: { committed_workflow_id?: string; status?: string };
    };
    expect(body.status).toBe("completed");
    expect(body.committed_workflow_id).toBeUndefined();
    expect(body.result?.status).toBe("active");
    expect(body.result?.committed_workflow_id).toBeUndefined();
  });
});

/**
 * Seed a live workflow + its current version. `steps` is the persisted
 * DAG's step list; tests diff a draft against it to drive the
 * structural-honesty gate.
 */
async function seedWorkflow(
  slug: string,
  steps: Array<Record<string, unknown>>,
): Promise<{ workflow_id: string; version_id: string; slug: string; name: string }> {
  const name = `wf ${slug}`;
  const [workflow] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: principal.tenant_id, slug, name, lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("workflow insert failed");
  const [version] = await testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: principal.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: { name, slug, steps },
    })
    .returning();
  if (!version) throw new Error("workflow version insert failed");
  await testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  return { workflow_id: workflow.id, version_id: version.id, slug, name };
}

describe("conversation_get — respond_elicitation in-flight vs crashed", () => {
  async function seedAwaitingInputWithPendingElicitation(): Promise<{
    conversation_id: string;
    elicitation_id: string;
  }> {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "awaiting_input",
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id: conv.id,
        tool_name: "ask_user_confirm",
        summary: "confirm proceed",
        input: { kind: "generic" },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");
    return { conversation_id: conv.id, elicitation_id: elicitation.id };
  }

  test("an in-flight respond_elicitation (job enqueued, no result) reports working — not a re-prompt", async () => {
    const { conversation_id } = await seedAwaitingInputWithPendingElicitation();
    // The durable in-flight marker: a job WAS enqueued (job_id set) and the
    // worker has not written result/failure/cancel yet.
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id,
      turn_seq: 1,
      kind: "respond_elicitation",
      actor_id: principal.id,
      request_source: "mcp",
      job_id: "job-inflight",
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as { status: string };
    // Still resolving — keep polling, do NOT re-surface the same form.
    expect(body.status).toBe("working");
  });

  test("a CRASHED respond_elicitation (no job_id) re-surfaces the pending form instead of working forever", async () => {
    const { conversation_id, elicitation_id } = await seedAwaitingInputWithPendingElicitation();
    // The crash state: the task row was inserted but the process died
    // BEFORE setMcpTaskJobId — no job_id, no result, no failure, no cancel.
    // Pre-fix `!result` alone read this as "actively resolving" forever and
    // permanently suppressed the still-pending elicitation.
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id,
      turn_seq: 1,
      kind: "respond_elicitation",
      actor_id: principal.id,
      request_source: "mcp",
      // job_id intentionally omitted (null)
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      pending_elicitation_id?: string;
    };
    expect(body.status).toBe("input_required");
    expect(body.pending_elicitation_id).toBe(elicitation_id);
  });
});

describe("conversation_get — native MCP elicitation delivery", () => {
  async function seedNativeChoice(): Promise<{ conversation_id: string; elicitation_id: string }> {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "awaiting_input",
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id: conv.id,
        tool_name: "ask_user_choice",
        summary: "choose rollout",
        input: {
          question: "Choose rollout",
          options: [
            { value: "canary", label: "Canary" },
            { value: "full", label: "Full" },
          ],
        },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      request_source: "mcp",
      result: { conversation_id: conv.id, status: "awaiting_input", events: [] },
    });
    return { conversation_id: conv.id, elicitation_id: elicitation.id };
  }

  test("delivers the persisted choice through the live MCP request and queues its answer", async () => {
    const { conversation_id, elicitation_id } = await seedNativeChoice();
    let calls = 0;
    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
      nativeElicitation: {
        elicitForm: async (params) => {
          calls += 1;
          expect(params.requestedSchema.properties.value).toMatchObject({
            type: "string",
            enum: ["canary", "full"],
          });
          return { action: "accept", content: { value: "canary" } };
        },
      },
    });
    expect(got.isError).toBe(false);
    expect(calls).toBe(1);
    const [row] = await testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation_id));
    expect(row?.protocol_native).toBe(true);
    expect(row?.delivery_attempts).toBe(1);
    expect(row?.output).toEqual({ value: "canary", option_index: 0 });
    const tasks = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conversation_id));
    expect(tasks.some((task) => task.kind === "respond_elicitation" && task.job_id)).toBe(true);
  });

  test("a concurrent poll sees the durable lease and does not open a second dialog", async () => {
    const { conversation_id } = await seedNativeChoice();
    let releaseFirst: (() => void) | undefined;
    const firstAnswer = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const nativeElicitation = {
      elicitForm: async () => {
        calls += 1;
        await firstAnswer;
        return { action: "cancel" as const };
      },
    };
    const first = handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
      nativeElicitation,
    });
    while (calls === 0) await Bun.sleep(5);
    const second = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
      nativeElicitation,
    });
    const secondBody = JSON.parse(second.content[0]?.text ?? "{}") as {
      phase?: string;
    };
    expect(secondBody.phase).toBe("awaiting_human_input");
    expect(calls).toBe(1);
    releaseFirst?.();
    await first;
  });
});

describe("conversation_get — working heartbeat", () => {
  test("a non-terminal turn reports numeric elapsed_ms + the newest action", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    // A live (non-terminal) task row — no result/failure/cancel.
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      request_source: "mcp",
    });
    // The newest authoring step drives last_action / phase / step.
    await testDb.db.insert(conversationToolCalls).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      tool: "dry_run_workflow",
      input: { step_id: "shape" },
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      elapsed_ms: unknown;
      last_action: unknown;
      phase: unknown;
      step: unknown;
    };
    expect(body.status).toBe("working");
    expect(typeof body.elapsed_ms).toBe("number");
    expect(body.elapsed_ms as number).toBeGreaterThanOrEqual(0);
    expect(body.last_action).toBe("dry_run_workflow");
    expect(body.phase).toBe("validating");
    expect(body.step).toBe("shape");
  });

  // The authoring pipeline collapsed to two write tools; the heartbeat
  // must report a truthful phase for each. Pre-fix `author_workflow`
  // fell through the retired `build_/propose_/update_` prefix bucket to
  // a generic `phase:"working"`, so a 30-60s build turn read as a hang.
  test.each([
    ["author_workflow", "building"],
    ["edit_workflow_patch", "editing"],
  ])("%s maps to phase:%s", async (tool, expectedPhase) => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      request_source: "mcp",
    });
    await testDb.db.insert(conversationToolCalls).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      tool,
      input: {},
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      last_action: unknown;
      phase: unknown;
    };
    expect(body.last_action).toBe(tool);
    expect(body.phase).toBe(expectedPhase);
  });

  test("a task with no tool calls yet reports phase:starting with null last_action", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      request_source: "mcp",
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      phase: unknown;
      last_action: unknown;
      elapsed_ms: unknown;
    };
    expect(body.status).toBe("working");
    expect(body.phase).toBe("starting");
    expect(body.last_action).toBeNull();
    expect(typeof body.elapsed_ms).toBe("number");
  });
});

// Option-B: the worker stamps phase/last_action/progress_step/heartbeat_at
// on the live `mcp_tasks` row as each tool runs, and `conversation_get`
// reports THOSE (authoritative) — falling back to the tool-call derivation
// only when the row carries no stamp.
describe("conversation_get — worker-stamped heartbeat (Option-B)", () => {
  test("the stamp is authoritative over the newest tool-call derivation", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      request_source: "mcp",
    });
    // The newest tool-call row would DERIVE `validating`; the worker
    // stamp says `building`. The stamp must win.
    await testDb.db.insert(conversationToolCalls).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      tool: "dry_run_workflow",
      input: { step_id: "shape" },
    });
    await stampMcpTaskProgress(
      principal.tenant_id,
      conv.id,
      "author_workflow",
      { id: "wf-slug" },
      testDb.db,
    );

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      phase: unknown;
      last_action: unknown;
      step: unknown;
    };
    expect(body.status).toBe("working");
    expect(body.phase).toBe("building");
    expect(body.last_action).toBe("author_workflow");
    expect(body.step).toBe("wf-slug");
  });

  test("a moving turn advances the stamped phase + heartbeat_at monotonically", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      request_source: "mcp",
    });

    await stampMcpTaskProgress(principal.tenant_id, conv.id, "author_workflow", {}, testDb.db);
    const [first] = await testDb.db
      .select({ phase: mcpTasks.phase, heartbeat_at: mcpTasks.heartbeat_at })
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conv.id));
    if (!first?.heartbeat_at) throw new Error("first stamp did not land");
    expect(first.phase).toBe("building");

    // A later tool stamps a new phase and a fresh heartbeat.
    await new Promise((r) => setTimeout(r, 5)); // allow-wall-clock
    await stampMcpTaskProgress(principal.tenant_id, conv.id, "save_workflow_draft", {}, testDb.db);
    const [second] = await testDb.db
      .select({ phase: mcpTasks.phase, heartbeat_at: mcpTasks.heartbeat_at })
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conv.id));
    if (!second?.heartbeat_at) throw new Error("second stamp did not land");
    expect(second.phase).toBe("committing");
    expect(second.heartbeat_at.getTime()).toBeGreaterThanOrEqual(first.heartbeat_at.getTime());

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    const body = JSON.parse(got.content[0]?.text ?? "{}") as { phase: unknown };
    expect(body.phase).toBe("committing");
  });

  test("a null stamp falls back to the tool-call derivation", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    // Live task row with NO stamp (a legacy/in-flight row).
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      request_source: "mcp",
    });
    await testDb.db.insert(conversationToolCalls).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      tool: "dry_run_workflow",
      input: { step_id: "shape" },
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      phase: unknown;
      last_action: unknown;
      step: unknown;
    };
    // Derived from the tool call, not a stamp.
    expect(body.phase).toBe("validating");
    expect(body.last_action).toBe("dry_run_workflow");
    expect(body.step).toBe("shape");
  });

  test("a stamp never resurrects a terminal (result-bearing) task row", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      request_source: "mcp",
      result: { conversation_id: conv.id, status: "committed", events: [] },
    });

    await stampMcpTaskProgress(principal.tenant_id, conv.id, "author_workflow", {}, testDb.db);
    const [row] = await testDb.db
      .select({ phase: mcpTasks.phase, heartbeat_at: mcpTasks.heartbeat_at })
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conv.id));
    // Terminal row is untouched — the stamp's WHERE excludes it.
    expect(row?.phase ?? null).toBeNull();
    expect(row?.heartbeat_at ?? null).toBeNull();
  });
});

describe("conversation_commit — inline auto-commit reconciliation", () => {
  test("null target_workflow_id but a bound draft resolves the committed workflow (not the error)", async () => {
    // Reproduces the inline auto-commit case: a green dry_run_workflow
    // persisted the workflow but the conversation row's
    // target_workflow_id ended up null. The draft's bound resource still
    // points at the live workflow, so conversation_commit must report it
    // idempotently instead of "conversation has no committed workflow".
    const wf = await seedWorkflow("hb-committed", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        // The defect state: the row was never stamped with the target.
        target_workflow_id: null,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    // Bind the draft to the live workflow the way commitWorkflowAtomic
    // does — an empty-steps draft classifies as `no_target`, so the
    // structural-honesty gate does not fire on this clean commit.
    const boundDraft = withWorkflowPersisted(
      { workflow: { name: wf.name, steps: [] } },
      {
        kind: "workflow",
        id: wf.workflow_id,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.version_id,
        version: 1,
        environment: null,
        saved_at: "2026-07-01T00:00:00.000Z",
      },
    );
    await appendSnapshot(principal.tenant_id, conv.id, boundDraft, testDb.db);

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      workflow_id: string;
      conversation_id: string;
      committed?: { workflow_version_id: string; version: number; steps_present: number };
      draft_state?: string;
      verified_against_draft?: boolean;
      note?: string;
      usage?: unknown;
    };
    expect(body.workflow_id).toBe(wf.workflow_id);
    expect(body.conversation_id).toBe(conv.id);
    expect(body.usage).toBeDefined();
    // The reply's committed block is derived from the persisted rows, and an
    // empty draft says so instead of implying verification.
    expect(body.committed).toEqual(
      expect.objectContaining({
        workflow_version_id: wf.version_id,
        version: 1,
        steps_present: 1,
      }),
    );
    expect(body.draft_state).toBe("empty_draft");
    expect(body.verified_against_draft).toBe(false);
    expect(body.note).toBeDefined();
  });

  test("a stamped target_workflow_id still commits and carries usage", async () => {
    const wf = await seedWorkflow("hb-stamped", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: wf.workflow_id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      workflow_id: string;
      committed?: { workflow_version_id: string; version: number; steps_present: number };
    };
    expect(body.workflow_id).toBe(wf.workflow_id);
    // Response mirrors the persisted rows exactly.
    const [wfRow] = await testDb.db
      .select({ current_version_id: workflows.current_version_id })
      .from(workflows)
      .where(eq(workflows.id, wf.workflow_id));
    const [vRow] = await testDb.db
      .select({ version: workflowVersions.version, dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, wf.version_id));
    expect(body.committed?.workflow_version_id).toBe(wfRow?.current_version_id ?? "");
    expect(body.committed?.version).toBe(vRow?.version ?? -1);
    expect(body.committed?.steps_present).toBe(
      ((vRow!.dag as { steps?: unknown[] })?.steps ?? []).length,
    );
  });

  test("a workflow with no persisted version returns NOT COMMITTED, not success", async () => {
    // A no-op commit: the workflow row exists but nothing was ever versioned.
    const [workflow] = await testDb.db
      .insert(workflows)
      .values({
        tenant_id: principal.tenant_id,
        slug: "hb-unversioned",
        name: "wf hb-unversioned",
        lifecycle: "draft",
      })
      .returning();
    if (!workflow) throw new Error("workflow insert failed");
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: workflow.id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(true);
    expect(got.content[0]?.text ?? "").toContain("NOT COMMITTED");
    expect(got.content[0]?.text ?? "").toContain("no persisted version");
  });

  test("an unreadable persisted dag returns COMMIT UNVERIFIED, not success", async () => {
    const wf = await seedWorkflow("hb-corrupt", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    await testDb.db
      .update(workflowVersions)
      .set({ dag: { not_a: "workflow" } })
      .where(eq(workflowVersions.id, wf.version_id));
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: wf.workflow_id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    // A non-empty bound draft so the classifier reaches the dag parse.
    const boundDraft: DraftDocument = withWorkflowPersisted(
      {
        workflow: {
          name: wf.name,
          slug: wf.slug,
          steps: [
            { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
          ],
        },
      },
      {
        kind: "workflow",
        id: wf.workflow_id,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.version_id,
        version: 1,
        environment: null,
        saved_at: "2026-07-01T00:00:00.000Z",
      },
    );
    await appendSnapshot(principal.tenant_id, conv.id, boundDraft, testDb.db);

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(true);
    expect(got.content[0]?.text ?? "").toContain("COMMIT UNVERIFIED");
  });

  test("a structural draft still returns the NOT COMMITTED directive error", async () => {
    // The persisted version has one step; the working draft edits it to a
    // different step. conversation_commit is read-only, so echoing
    // "committed" would be a reported-not-written lie — it must refuse.
    const wf = await seedWorkflow("hb-structural", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "active",
        target_workflow_id: wf.workflow_id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    // The draft is BOUND to the live workflow (so loadDraft does not
    // re-hydrate it from the persisted dag) but its step has been edited
    // away from the persisted version — the uncommitted-edit state.
    const dirtyDraft: DraftDocument = withWorkflowPersisted(
      {
        workflow: {
          name: wf.name,
          slug: wf.slug,
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return { changed: true };",
            },
          ],
        },
      },
      {
        kind: "workflow",
        id: wf.workflow_id,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.version_id,
        version: 1,
        environment: null,
        saved_at: "2026-07-01T00:00:00.000Z",
      },
    );
    await appendSnapshot(principal.tenant_id, conv.id, dirtyDraft, testDb.db);

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(true);
    expect(got.content[0]?.text).toContain("NOT COMMITTED");
  });
});
