// One approved external MCP call, end to end, through the production pieces:
// the gate pauses, a PERSON answers the confirm, the harness grants, the
// model re-issues with the confirm marker, the remote tool runs once.
//
// Two contracts are pinned here:
//   1. The question a person reads names the connector as it was registered
//      and the tool as the server calls it — never the prefixed palette id —
//      and carries the same subject as data (`external_tool`) so a client can
//      phrase it in its own language.
//   2. The paused row ends with the decision. It used to stay `pending`
//      forever next to the grant row and the real result row.
//
// INJECTION PATTERN: a REAL mcp connector row, the pool's documented TEST
// SEAM (`__setMcpPoolFactoriesForTests`) for the SDK client only — no bun
// `mock.module`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { closeDb, type Db } from "../../../db/client.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
  tenants,
  users,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../../mcp/client/test-fixtures.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { resolveElicitationAndReactivate } from "../../elicitations.ts";
import { buildMessages } from "../../parts.ts";
import { maybeAutoPersistFromElicitation } from "../../persistence/auto-persist.ts";
import { pendingPrompt } from "../../resume.ts";
import { getConversation } from "../../service/get.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { buildExternalMcpTools } from "../sdk-wrap/external-mcp-tools.ts";
import type { TurnSignals } from "../sdk-wrap.ts";

let remoteCalls = 0;

const fakeClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return {
      tools: [
        {
          name: "search_items",
          title: "Search saved questions and dashboards",
          description: "Search Metabase.\nSecond line the card never shows.",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    };
  },
  async callTool() {
    remoteCalls += 1;
    return { content: [{ type: "text", text: "3 results" }], isError: false };
  },
  async readResource() {
    return { contents: [] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  async close() {},
};

function freshSignals(): TurnSignals {
  return {
    step: 0,
    toolChain: Promise.resolve(),
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    toolArgsRepeat: new Map(),
    toolValidationFingerprint: new Map(),
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
  };
}

type Execute = (
  input: Record<string, unknown>,
) => Promise<{ ok: boolean; data: Record<string, unknown> }>;

let ctx: TestDb;
let tenant_id: string;
let actor_id: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("external-mcp-approval-lifecycle");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-mcp-lifecycle", display_name: "MCP Approval Lifecycle" })
    .returning();
  tenant_id = t!.id;
  const [person] = await ctx.db
    .insert(users)
    .values({
      tenant_id,
      email: "approver@lifecycle.test.local",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  actor_id = person!.id;
  await seedMcpConnector(ctx.db, {
    tenant_id,
    slug: "metabase-reporting-mcp",
    display_name: "Metabase Reporting MCP",
    transport: "http",
    url: "https://metabase.lifecycletest.example.com/mcp",
  });
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (_origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = _origDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

async function paletteTool(conversation_id: string): Promise<Execute> {
  __resetMcpClientPoolForTests();
  const db = ctx.db as unknown as Db;
  const toolCtx: ToolContext = {
    db,
    tenant_id,
    conversation_id,
    actor_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id, actor_type: "user", db }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
  const principal: ResolvedPrincipal = {
    provider: "test",
    kind: "user",
    id: actor_id,
    tenant_id,
    roles: ["admin"],
  };
  const events: TurnEvent[] = [];
  const tools = await buildExternalMcpTools({
    db,
    principal,
    ctx: toolCtx,
    signals: freshSignals(),
    events,
  });
  const tool = tools["mcp_metabase-reporting-mcp__search_items"] as unknown as {
    execute: Execute;
  };
  expect(tool).toBeDefined();
  return tool.execute;
}

async function newConversation(): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  return conv!.id;
}

async function pendingConfirm(conversation_id: string) {
  const [row] = await ctx.db
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
        eq(conversationElicitations.status, "pending"),
      ),
    );
  expect(row).toBeDefined();
  return row!;
}

async function answer(conversation_id: string, confirmed: boolean) {
  const elicitation = await pendingConfirm(conversation_id);
  const output = { confirmed };
  const resolved = await resolveElicitationAndReactivate(
    {
      tenant_id,
      conversation_id,
      id: elicitation.id,
      output,
      decided_by: actor_id,
      ...(confirmed ? {} : { status: "cancelled" as const, reason: "user_declined" }),
    },
    ctx.db as unknown as Db,
  );
  expect(resolved.kind).toBe("resolved");
  await maybeAutoPersistFromElicitation({
    tenant_id,
    conversation_id,
    actor_id,
    answer_actor: { kind: "human", user_id: actor_id, via: "chat" },
    elicitation_output: output,
    elicitation: { id: elicitation.id, tool_name: elicitation.tool_name, input: elicitation.input },
    db: ctx.db as unknown as Db,
  });
}

async function toolCallRows(conversation_id: string) {
  return ctx.db
    .select()
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.conversation_id, conversation_id),
      ),
    );
}

describe("external MCP tool approval", () => {
  test("asks in words a person recognises, and carries the subject as data", async () => {
    const conversation_id = await newConversation();
    const execute = await paletteTool(conversation_id);
    const paused = await execute({ q: "revenue" });
    expect(paused.data.status).toBe("awaiting_confirmation");

    const elicitation = await pendingConfirm(conversation_id);
    const input = elicitation.input as Record<string, unknown>;
    expect(input.question).toBe('Run the tool "search_items" on Metabase Reporting MCP?');
    expect(String(input.question)).not.toContain("mcp_");
    expect(elicitation.summary).not.toContain("mcp_");
    expect(input.external_tool).toEqual({
      connector: "Metabase Reporting MCP",
      tool: "search_items",
      server_claim: "Search saved questions and dashboards",
    });
    // The server's own words are its claim, carried apart. What the approval
    // says it does is the engine's sentence — a server could title a
    // destructive tool "Read-only (safe)".
    expect((input.commit_intent as { description?: unknown }).description).toBe(
      'Lets the tool "search_items" on Metabase Reporting MCP run once.',
    );
    // The resume projection every client reads carries the same subject.
    expect(pendingPrompt(input).prompt).toMatchObject({
      intent_kind: "grant_relayed_tool_call",
      external_tool: {
        connector: "Metabase Reporting MCP",
        tool: "search_items",
        server_claim: "Search saved questions and dashboards",
      },
    });
    expect(remoteCalls).toBe(0);
  });

  test("an approved call leaves no pending row behind and runs exactly once", async () => {
    remoteCalls = 0;
    const conversation_id = await newConversation();
    const execute = await paletteTool(conversation_id);
    const paused = await execute({ q: "revenue" });
    const confirm_id = paused.data.confirm_id as string;
    expect(typeof confirm_id).toBe("string");

    await answer(conversation_id, true);
    const reissued = await execute({
      q: "revenue",
      __policy_confirmed: true,
      __policy_confirm_id: confirm_id,
    });
    expect(reissued.ok).toBe(true);
    expect(remoteCalls).toBe(1);

    const rows = await toolCallRows(conversation_id);
    expect(rows.filter((row) => row.outcome === "pending")).toEqual([]);
    const pausedRow = rows.find(
      (row) => (row.output as Record<string, unknown> | null)?.confirm_id === confirm_id,
    );
    // The paused row keeps the output replay shows the model — only its
    // verdict moved.
    expect(pausedRow?.outcome).toBe("ok");
    expect((pausedRow?.output as Record<string, unknown> | undefined)?.status).toBe(
      "awaiting_confirmation",
    );

    // Three rows, two cards: the grant row the harness injects carries no
    // anchor, so the transcript shows the paused call and the call that ran.
    expect(rows).toHaveLength(3);
    const detail = await getConversation(tenant_id, conversation_id, ctx.db as unknown as Db);
    const parts = buildMessages(detail!.messages, detail!.tool_calls).flatMap((m) => m.parts);
    const cards = parts.filter((part) => part.type === "tool_result");
    const ran = rows.find((row) => row.id !== pausedRow?.id && row.parent_message_id !== null);
    expect(cards.map((card) => card.call_id)).toEqual([pausedRow!.id, ran!.id]);
    expect(cards.map((card) => card.outcome)).toEqual(["ok", "ok"]);
  });

  test("a declined call ends its paused row as denied and never runs", async () => {
    remoteCalls = 0;
    const conversation_id = await newConversation();
    const execute = await paletteTool(conversation_id);
    const paused = await execute({ q: "revenue" });
    await answer(conversation_id, false);

    const rows = await toolCallRows(conversation_id);
    expect(rows.filter((row) => row.outcome === "pending")).toEqual([]);
    const pausedRow = rows.find(
      (row) =>
        (row.output as Record<string, unknown> | null)?.confirm_id === paused.data.confirm_id,
    );
    expect(pausedRow?.outcome).toBe("denied");
    expect(remoteCalls).toBe(0);
  });
});
