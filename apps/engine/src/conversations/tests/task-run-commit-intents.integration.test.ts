import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  apiKeys,
  connectors,
  conversations,
  executions,
  workflows,
} from "../../db/schema/index.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createElicitation, listElicitationsForConversation } from "../elicitations.ts";
import { appendMessage, insertToolCall } from "../persistence/index.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
  respondElicitationForTest,
} from "./setup.ts";
import {
  createRunConversation,
  driveTurn,
  markerFor,
  principalOf,
  sealConversation,
  seedBoundConnector,
  seedRunnableWorkflow,
  toolCalls,
} from "./task-run-fixtures.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c03);

let ctx: ConversationTestCtx;
let owner: ResolvedPrincipal;
let bound: Awaited<ReturnType<typeof seedRunnableWorkflow>>;
let other: Awaited<ReturnType<typeof seedRunnableWorkflow>>;
let connector: Awaited<ReturnType<typeof seedBoundConnector>>;
const originalMasterKey = testEnv.MASTER_KEY;

beforeAll(async () => {
  testEnv.MASTER_KEY = "a".repeat(64);
  ctx = await createConversationTestCtx("task_run_intents");
  owner = principalOf(ctx, ctx.user_id, "admin");
  bound = await seedRunnableWorkflow(ctx, "intent-bound");
  other = await seedRunnableWorkflow(ctx, "intent-other");
  connector = await seedBoundConnector(ctx, "intent-api");
}, 120_000);

afterAll(async () => {
  if (originalMasterKey === undefined) delete testEnv.MASTER_KEY;
  else testEnv.MASTER_KEY = originalMasterKey;
  await ctx.cleanup();
}, 60_000);

async function storedQuestion(
  conversation_id: string,
  intent: { kind: string; payload: Record<string, unknown> },
): Promise<string> {
  const tool_name = "ask_user_confirm";
  const db = ctx.testDb.db;
  const message = await appendMessage(db, ctx.tenant_id, conversation_id, "assistant", {});
  const input = {
    question: "Go ahead?",
    kind: "generic",
    commit_intent: { ...intent, description: "do it" },
  };
  const tool_call_id = await insertToolCall(db, {
    tenant_id: ctx.tenant_id,
    conversation_id,
    parent_message_id: message,
    tool: tool_name,
    input,
    approval_required: false,
  });
  const elicitation = await createElicitation(
    {
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool_call_id,
      parent_message_id: message,
      tool_name,
      summary: "Go ahead?",
      input,
      actor_id: owner.id,
      actor_type: "user",
    },
    db,
  );
  await db
    .update(conversations)
    .set({ status: "awaiting_input" })
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)));
  return elicitation.id;
}

async function ownerSaysYes(conversation_id: string, elicitation_id: string) {
  return respondElicitationForTest(
    {
      tenant_id: ctx.tenant_id,
      conversation_id,
      elicitation_id,
      actor_id: owner.id,
      principal: owner,
      output: { confirmed: true },
    },
    ctx.testDb.db,
  );
}

async function refusedSynthetic(conversation_id: string): Promise<boolean> {
  return JSON.stringify(await toolCalls(ctx, conversation_id)).includes(
    "task_run_commit_intent_refused",
  );
}

async function runsOf(workflow_id: string) {
  return ctx.testDb.db
    .select({ id: executions.id, execution_mode: executions.execution_mode })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, workflow_id)));
}

async function workflowAlive(id: string): Promise<boolean> {
  const [row] = await ctx.testDb.db
    .select({ deleted_at: workflows.deleted_at, name: workflows.name })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, id)));
  return row !== undefined && row.deleted_at === null && row.name === "intent-bound";
}

async function connectorAlive(id: string): Promise<boolean> {
  const rows = await ctx.testDb.db
    .select({ id: connectors.id })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, ctx.tenant_id), eq(connectors.id, id)));
  return rows.length === 1;
}

async function apiKeyCount(): Promise<number> {
  const rows = await ctx.testDb.db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.tenant_id, ctx.tenant_id));
  return rows.length;
}

function run(marker = markerFor({ workflow_ids: [bound.id], connector_ids: [connector.id] })) {
  return createRunConversation(ctx, owner.id, marker);
}

describe("a confirmed question in a task run performs nothing outside the task", () => {
  const kinds: Array<[string, () => Record<string, unknown>]> = [
    ["delete_workflow", () => ({ id: bound.id })],
    ["delete_connector", () => ({ id: connector.id, confirm_orphan: true })],
    ["create_api_key", () => ({ name: "smuggled", role: "admin" })],
    ["update_workflow_metadata", () => ({ workflow_id: bound.id, name: "renamed" })],
    ["apply_workflow_patch", () => ({ patches: [{ op: "add", path: "/steps/-", value: {} }] })],
    ["save_workflow_draft", () => ({ force_commit: true })],
    ["save_connector_draft", () => ({ force_save: true })],
    ["rollback_after_execute", () => ({ execution_id: nextUuid() })],
    ["oauth_completed", () => ({})],
    ["credential_reissue_completed", () => ({})],
  ];
  for (const [kind, payload] of kinds) {
    test(`${kind} is refused after the owner's yes`, async () => {
      const conversation_id = await run();
      const keys = await apiKeyCount();
      const id = await storedQuestion(conversation_id, { kind, payload: payload() });
      await ownerSaysYes(conversation_id, id);
      expect(await refusedSynthetic(conversation_id)).toBe(true);
      expect(await workflowAlive(bound.id)).toBe(true);
      expect(await connectorAlive(connector.id)).toBe(true);
      expect(await apiKeyCount()).toBe(keys);
    }, 120_000);
  }

  test("run_workflow for a workflow outside the task is refused", async () => {
    const conversation_id = await run();
    for (const payload of [{ workflow_id: other.id }, { workflow: other.slug }]) {
      const id = await storedQuestion(conversation_id, { kind: "run_workflow", payload });
      await ownerSaysYes(conversation_id, id);
    }
    expect(await runsOf(other.id)).toHaveLength(0);
    expect(await refusedSynthetic(conversation_id)).toBe(true);
  }, 120_000);

  test("run_workflow for a bound workflow runs in the task environment, whatever the intent says", async () => {
    const conversation_id = await run();
    const before = (await runsOf(bound.id)).length;
    const id = await storedQuestion(conversation_id, {
      kind: "run_workflow",
      payload: { workflow_id: bound.id, environment: "prod" },
    });
    await ownerSaysYes(conversation_id, id);
    const after = await runsOf(bound.id);
    expect(after).toHaveLength(before + 1);
    expect(after.every((row) => row.execution_mode === "dev")).toBe(true);
  }, 120_000);

  test("a sealed run refuses even a bound run_workflow and forged engine kinds", async () => {
    const conversation_id = await run();
    await sealConversation(ctx, conversation_id);
    const before = (await runsOf(bound.id)).length;
    for (const intent of [
      { kind: "run_workflow", payload: { workflow_id: bound.id } },
      {
        kind: "execute_confirmed_tool_call",
        payload: { tool: "call_connector", approval_id: nextUuid() },
      },
      {
        kind: "commit_held_workflow_writes",
        payload: { tool: "run_workflow", approval_id: nextUuid() },
      },
    ]) {
      const id = await storedQuestion(conversation_id, intent);
      await ownerSaysYes(conversation_id, id);
    }
    expect(await runsOf(bound.id)).toHaveLength(before);
    expect(await refusedSynthetic(conversation_id)).toBe(true);
  }, 120_000);

  test("a forged engine kind without a real approval, or for a tool outside the palette, performs nothing", async () => {
    const conversation_id = await run();
    const keys = await apiKeyCount();
    for (const intent of [
      {
        kind: "execute_confirmed_tool_call",
        payload: { tool: "create_api_key", approval_id: nextUuid() },
      },
      {
        kind: "execute_confirmed_tool_call",
        payload: { tool: "call_connector", approval_id: nextUuid() },
      },
      { kind: "grant_relayed_tool_call", payload: { tool: "delete_workflow" } },
    ]) {
      const id = await storedQuestion(conversation_id, intent);
      await ownerSaysYes(conversation_id, id);
    }
    expect(await apiKeyCount()).toBe(keys);
    expect(await workflowAlive(bound.id)).toBe(true);
    const calls = await toolCalls(ctx, conversation_id);
    expect(calls.filter((row) => row.outcome === "ok" && row.tool !== "ask_user_confirm")).toEqual(
      [],
    );
  }, 120_000);

  test("the model cannot attach an action to a question in a task run", async () => {
    const conversation_id = await run();
    const outcome = await driveTurn(ctx, conversation_id, owner, [
      {
        tool: "ask_user_confirm",
        args: {
          question: "Delete it?",
          commit_intent: {
            kind: "delete_workflow",
            payload: { id: bound.id },
            description: "delete",
          },
        },
      },
      {
        tool: "ask_user_confirm",
        args: { question: "Save?", kind: "save_workflow_draft" },
      },
      {
        tool: "ask_user_form",
        args: {
          question: "Input?",
          fields: [{ name: "a", label: "A", type: "text" }],
          commit_intent: {
            kind: "run_workflow",
            payload: { workflow_id: other.id },
            description: "run",
          },
        },
      },
      { text: "I can only ask plain questions here." },
    ]);
    expect(outcome.result.status).toBe("active");
    const pending = (
      await listElicitationsForConversation(ctx.tenant_id, conversation_id, ctx.testDb.db)
    ).filter((row) => row.status === "pending");
    expect(pending).toEqual([]);
    const refused = (await toolCalls(ctx, conversation_id)).filter((row) =>
      JSON.stringify(row.output).includes("task_run_commit_intent_refused"),
    );
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(await workflowAlive(bound.id)).toBe(true);
  }, 120_000);

  test("an approved connector write is refused when its connector is no longer bound", async () => {
    const conversation_id = await run();
    const asked = await driveTurn(ctx, conversation_id, owner, [
      {
        tool: "call_connector",
        args: { connector_id: connector.id, method: "POST", path: "/things", body: {} },
      },
    ]);
    expect(asked.result.status).toBe("awaiting_input");
    const [pending] = (
      await listElicitationsForConversation(ctx.tenant_id, conversation_id, ctx.testDb.db)
    ).filter((row) => row.status === "pending");
    if (!pending) throw new Error("expected a pending approval");
    const [row] = await ctx.testDb.db
      .select({ draft: conversations.draft })
      .from(conversations)
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)),
      );
    const draft = row?.draft as { session: { task_run: Record<string, unknown> } };
    await ctx.testDb.db
      .update(conversations)
      .set({
        draft: {
          ...draft,
          session: { ...draft.session, task_run: { ...draft.session.task_run, connector_ids: [] } },
        },
      })
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)),
      );
    await ownerSaysYes(conversation_id, pending.id);
    const text = JSON.stringify(await toolCalls(ctx, conversation_id));
    expect(text).toMatch(/task_run_connector_not_bound|connector_not_in_allowlist/);
  }, 120_000);

  test("an ordinary conversation still performs a confirmed delete", async () => {
    const victim = await seedRunnableWorkflow(ctx, "intent-victim");
    const conversation_id = await createRunConversation(ctx, owner.id, null);
    const id = await storedQuestion(conversation_id, {
      kind: "delete_workflow",
      payload: { id: victim.id },
    });
    await ownerSaysYes(conversation_id, id);
    const [row] = await ctx.testDb.db
      .select({ deleted_at: workflows.deleted_at })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, victim.id)));
    expect(row === undefined || row.deleted_at !== null).toBe(true);
  }, 120_000);
});
