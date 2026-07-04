// Confirm-prompt contract for external `mcp_<ns>__<tool>` tools: the
// pending envelope surfaces the tool identity + input FIELD NAMES only.
// External tool args are bound for a third-party server and may carry
// sensitive data, so the pending output must NEVER echo input values —
// the operator sees `pending_output: { namespace, remote_tool, input_keys }`
// (mirroring run_workflow's buildPendingOutput) instead of a raw JSON blob.
//
// INJECTION PATTERN: a REAL mcp_servers row is registered and the pool's
// documented TEST SEAM (`__setMcpPoolFactoriesForTests`) swaps only the SDK
// Client construction for an in-process fake — NO bun `mock.module` (module
// mocks are process-global and leak into every other test file in the same
// worker). The palette is assembled through the real pool code (handshake,
// manifest hash, audit), then the synthetic tool is dispatched WITHOUT
// `__policy_confirmed` and the pending branch must fire (no remote invoke)
// with a values-free envelope.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { closeDb, type Db } from "../../../db/client.ts";
import { conversations, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../../mcp/client/pool.ts";
import { createMcpServer } from "../../../mcp/client/registry.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { buildExternalMcpTools } from "../sdk-wrap/external-mcp-tools.ts";
import type { TurnSignals } from "../sdk-wrap.ts";

// Counts remote invocations: the pending gate must fire BEFORE any
// `callTool` reaches the (fake) remote server.
let remoteCallToolCalls = 0;

const fakeClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return {
      tools: [
        {
          name: "create_page",
          description: "Create a page on the remote server",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  },
  async callTool() {
    remoteCallToolCalls += 1;
    return { content: [], isError: false };
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

let ctx: TestDb;
let tenant_id: string;
let actor_id: string;
let conversation_id: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("external-mcp-pending-output");
  // Pin DATABASE_URL + reset the global pool so any getDb() fallback inside
  // the real pool/handshake path dials this suite's isolated test database
  // (same discipline as the pool-*.test.ts suites).
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-mcp-pending", display_name: "MCP Pending Output" })
    .returning();
  tenant_id = t!.id;
  actor_id = "00000000-0000-0000-0000-000000000002";
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;

  // Real server row — `none` auth so the (fake) handshake needs no credential.
  await createMcpServer(
    ctx.db,
    {
      tenant_id,
      name: "Example MCP",
      namespace: "examplemcp",
      transport: "http",
      url: "https://examplemcp.pendingtest.example.com/mcp",
    },
    { actor_id, request_source: "api", executor: ctx.db },
  );
}, 30_000);

afterAll(async () => {
  // ALWAYS restore the seam (null-by-default protects production, but a
  // leaked non-null factory would still poison sibling test files).
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (_origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = _origDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

describe("external MCP tool confirm envelope", () => {
  test("pending output carries input_keys, never input values", async () => {
    __resetMcpClientPoolForTests();
    const events: TurnEvent[] = [];
    const db = ctx.db as unknown as Db;
    const engineClient = new EngineClient({
      tenant_id,
      actor_id,
      actor_type: "user",
      db,
    });
    const toolCtx: ToolContext = {
      db,
      tenant_id,
      conversation_id,
      actor_id,
      connector_id: null,
      workflow_id: null,
      engineClient,
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

    const tools = await buildExternalMcpTools({
      db,
      principal,
      ctx: toolCtx,
      signals: freshSignals(),
      events,
    });
    const toolName = "mcp_examplemcp__create_page";
    expect(Object.keys(tools)).toContain(toolName);

    // First dispatch carries NO confirmation marker → the policy gate must
    // pause with a pending envelope (mcp_ tools confirm before execution).
    const SENSITIVE_TITLE = "Customer ACME quarterly numbers";
    const SENSITIVE_BODY = "internal-secret-figure-42";
    const execute = (
      tools[toolName] as unknown as {
        execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown }>;
      }
    ).execute;
    const result = await execute({ title: SENSITIVE_TITLE, body: SENSITIVE_BODY });

    const data = result.data as Record<string, unknown>;
    expect(data.pending).toBe(true);
    expect(data.status).toBe("awaiting_confirmation");

    // Operator-facing summary: identity + field names only. `input_keys`
    // is sorted, so the envelope is deterministic regardless of the order
    // the LLM emitted the argument keys in.
    expect(data.pending_output).toEqual({
      namespace: "examplemcp",
      remote_tool: "create_page",
      input_keys: ["body", "title"],
    });

    // No input VALUE appears anywhere in the pending envelope.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(SENSITIVE_TITLE);
    expect(serialized).not.toContain(SENSITIVE_BODY);

    // The remote tool was never invoked while the confirmation is pending.
    expect(remoteCallToolCalls).toBe(0);
  });
});
