import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { closeDb, type Db } from "../../db/client.ts";
import {
  auditLog,
  conversations,
  tenants,
  toolApprovals,
  users,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { _resetLoggerForTests, reconfigureLogger } from "../../logging/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { type CapturedLog, logRing } from "../../observability/log-ring.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { hashToolArgs } from "../../tools/approval.ts";
import { tryFastPath } from "../fast-path.ts";
import { getTool, type ToolContext } from "../tools/index.ts";
import { buildExternalMcpTools } from "../tools/sdk-wrap/external-mcp-tools.ts";
import { wrapOne } from "../tools/sdk-wrap/invoke.ts";
import { buildSyntheticWorkflowTools } from "../tools/sdk-wrap/synthetic-workflow-tools.ts";
import type { TurnEvent } from "../types.ts";
import { freshSignals } from "./turn-signals.ts";

let remoteToolCalls = 0;

const fakeMcpClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return {
      tools: [
        {
          name: "create_page",
          description: "Create a page on the remote server",
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
        },
      ],
    };
  },
  async callTool() {
    remoteToolCalls += 1;
    return { content: [], isError: false };
  },
  async readResource() {
    return { contents: [] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  async close() {},
};

let tdb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;
let principal: ResolvedPrincipal;
let remote: MockServer;
let remoteWrites = 0;
const originalDatabaseUrl = testEnv.DATABASE_URL;

const KNOWLEDGE_ARGS = { mode: "inline", name: "Parity source", content: "# Parity" };
const EXTERNAL_ARGS = { title: "Parity page" };

function toolCtx(
  conversation_id: string,
  surface: NonNullable<ToolContext["surface"]>,
  askBeforeWriting = false,
): ToolContext {
  return {
    db,
    tenant_id: tenantId,
    conversation_id,
    actor_id: userId,
    principal,
    ...(askBeforeWriting ? { ask_before_writing: true } : {}),
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: tenantId,
      actor_id: userId,
      actor_type: "user",
      db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
    surface,
  };
}

async function newConversation(): Promise<string> {
  const [row] = await tdb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation seed failed");
  return row.id;
}

async function seedWorkflow(slug: string, method: "GET" | "POST"): Promise<{ id: string }> {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug, name: slug, lifecycle: "active", is_tool: true })
    .returning();
  if (!wf) throw new Error("workflow seed failed");
  const [version] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: {
        name: slug,
        slug,
        steps: [
          method === "POST"
            ? {
                id: "send",
                kind: "request",
                method,
                url: `${remote.baseUrl}/send`,
                body: { ok: true },
              }
            : { id: "read", kind: "request", method, url: `${remote.baseUrl}/read` },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("version seed failed");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, wf.id));
  return { id: wf.id };
}

async function gateDecisionLogs<T>(
  run: () => Promise<T>,
): Promise<{ value: T; logs: CapturedLog[] }> {
  const logs: CapturedLog[] = [];
  const unsubscribe = logRing.subscribe((entry) => {
    if (entry.action === "tool_policy.resolved") logs.push(entry);
  });
  try {
    const value = await run();
    return { value, logs };
  } finally {
    unsubscribe();
  }
}

async function approvalsFor(tool: string) {
  return tdb.db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, tenantId), eq(toolApprovals.tool, tool)));
}

async function approvalRequestedRows(approvalId: string) {
  return tdb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        eq(auditLog.action, AuditAction.APPROVAL_REQUESTED),
        eq(auditLog.resource_id, approvalId),
      ),
    );
}

async function confirmationRequiredRows(conversationId: string) {
  return tdb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        eq(auditLog.action, AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED),
        eq(auditLog.resource_id, conversationId),
      ),
    );
}

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeMcpClient });
  tdb = await createTestDb("confirm-gate-parity");
  db = tdb.db as unknown as Db;
  await closeDb();
  testEnv.DATABASE_URL = tdb.url;
  resetMockProvider();
  reconfigureLogger({ level: "debug" });
  remote = await createMockServer((req, res) => {
    if (req.method === "POST") remoteWrites += 1;
    return jsonResponse(res, 200, { ok: true });
  });
  const [tenant] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-confirm-gate-parity", display_name: "Confirm Gate Parity" })
    .returning();
  if (!tenant) throw new Error("tenant seed failed");
  tenantId = tenant.id;
  const [person] = await tdb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "approver@confirm-gate-parity.test.local",
      role_id: await builtinRoleId(tdb.db, "admin"),
    })
    .returning();
  if (!person) throw new Error("user seed failed");
  userId = person.id;
  principal = { provider: "test", kind: "user", id: userId, tenant_id: tenantId, roles: ["admin"] };
  await seedMcpConnector(tdb.db, {
    tenant_id: tenantId,
    slug: "paritymcp",
    display_name: "Parity MCP",
    transport: "http",
    url: "https://paritymcp.gatetest.example.com/mcp",
  });
}, 30_000);

afterAll(async () => {
  _resetLoggerForTests();
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await remote.close();
  await closeDb();
  if (originalDatabaseUrl === undefined) delete testEnv.DATABASE_URL;
  else testEnv.DATABASE_URL = originalDatabaseUrl;
  await tdb.cleanup();
}, 30_000);

describe("confirm gate parity — one gate behind every entry point", () => {
  test("loop conversation tool (wrapOne) when the person asks before writing: one approval, one APPROVAL_REQUESTED, confirmation_required, one decision log", async () => {
    const conversationId = await newConversation();
    const inner = getTool("create_knowledge_source");
    if (!inner) throw new Error("create_knowledge_source is not registered");
    const events: TurnEvent[] = [];
    const wrapped = wrapOne(
      inner,
      toolCtx(conversationId, "web", true),
      freshSignals(),
      events,
      db,
      {},
    );
    const { value: result, logs } = await gateDecisionLogs(async () =>
      wrapped.execute!(KNOWLEDGE_ARGS, { toolCallId: "parity-invoke", messages: [], context: {} }),
    );
    expect(result).toMatchObject({ ok: false, pause: { tool_name: "ask_user_confirm" } });

    const rows = (await approvalsFor("create_knowledge_source")).filter(
      (r) => r.surface === "chat",
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.args_hash).toBe(hashToolArgs(KNOWLEDGE_ARGS));
    expect(await approvalRequestedRows(row.id)).toHaveLength(1);
    expect(await confirmationRequiredRows(conversationId)).toHaveLength(1);

    expect(logs).toHaveLength(1);
    expect(logs[0]?.fields).toMatchObject({
      tool: "create_knowledge_source",
      rule: "ask_before_writing",
      mode: "confirm_before_execution",
      outcome: "confirm",
      surface: "web",
      conversation_id: conversationId,
    });
  });

  test("external MCP tool: one approval with the remote args' hash, confirmation_required, one decision log, no remote call", async () => {
    __resetMcpClientPoolForTests();
    const conversationId = await newConversation();
    const events: TurnEvent[] = [];
    const tools = await buildExternalMcpTools({
      db,
      principal,
      ctx: toolCtx(conversationId, "sk_interactive"),
      signals: freshSignals(),
      events,
    });
    const tool = tools.mcp_paritymcp__create_page;
    if (!tool?.execute) throw new Error("external MCP palette entry missing");
    const before = remoteToolCalls;
    const { value: result, logs } = await gateDecisionLogs(async () =>
      tool.execute!(EXTERNAL_ARGS, { toolCallId: "parity-external", messages: [], context: {} }),
    );
    expect(result).toMatchObject({ ok: false, data: { status: "awaiting_confirmation" } });
    expect(remoteToolCalls).toBe(before);

    const rows = await approvalsFor("mcp_paritymcp__create_page");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.args_hash).toBe(hashToolArgs(EXTERNAL_ARGS));
    expect(row.surface).toBe("chat");
    expect(await approvalRequestedRows(row.id)).toHaveLength(1);
    expect(await confirmationRequiredRows(conversationId)).toHaveLength(1);

    expect(logs).toHaveLength(1);
    expect(logs[0]?.fields).toMatchObject({
      tool: "mcp_paritymcp__create_page",
      rule: "write_gate",
      mode: "confirm_before_execution",
      outcome: "confirm",
      surface: "sk_interactive",
      conversation_id: conversationId,
    });
  });

  test("wf_<slug> tool: held writes open one approval under the held_writes rule after the preview run", async () => {
    const slug = "parity-held-delivery";
    await seedWorkflow(slug, "POST");
    const conversationId = await newConversation();
    const events: TurnEvent[] = [];
    const tools = await buildSyntheticWorkflowTools({
      db,
      principal,
      ctx: toolCtx(conversationId, "web"),
      signals: freshSignals(),
      events,
      toolPolicies: { run_workflow: "confirm_before_execution" },
    });
    const tool = tools[`wf_${slug}`];
    if (!tool?.execute) throw new Error("wf_ tool missing");
    const writesBefore = remoteWrites;
    const { value: result, logs } = await gateDecisionLogs(async () =>
      tool.execute!({}, { toolCallId: "parity-wf", messages: [], context: {} }),
    );
    expect(result).toMatchObject({ ok: false, pause: { tool_name: "ask_user_confirm" } });
    expect(remoteWrites).toBe(writesBefore);

    const rows = await approvalsFor(`wf_${slug}`);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.args_hash).toBe(hashToolArgs({}));
    const requested = await approvalRequestedRows(row.id);
    expect(requested).toHaveLength(1);
    expect(requested[0]?.metadata).toMatchObject({ resolver_reason: "held_writes" });
    expect(await confirmationRequiredRows(conversationId)).toHaveLength(1);

    expect(logs).toHaveLength(1);
    expect(logs[0]?.fields).toMatchObject({
      tool: `wf_${slug}`,
      rule: "held_writes",
      mode: "confirm_before_execution",
      outcome: "confirm",
      surface: "web",
      conversation_id: conversationId,
    });
  });

  test("fast path: run <slug> passes the same gate; with no override it proceeds and opens nothing", async () => {
    const slug = "parity-fast-read";
    await seedWorkflow(slug, "GET");
    const conversationId = await newConversation();
    const { value: hit, logs } = await gateDecisionLogs(() =>
      tryFastPath({
        db,
        tenant_id: tenantId,
        conversation_id: conversationId,
        actor_id: userId,
        principal,
        user_message: `run ${slug}`,
        answer_actor: TEST_HUMAN_ANSWER,
        surface: "web",
      }),
    );
    expect(hit?.status).toBe("active");
    expect(hit?.fast_path_tool).toBe("run_workflow");
    expect((await approvalsFor("run_workflow")).filter((r) => r.surface === "chat")).toHaveLength(
      0,
    );
    expect(await confirmationRequiredRows(conversationId)).toHaveLength(0);

    expect(logs).toHaveLength(1);
    expect(logs[0]?.fields).toMatchObject({
      tool: "run_workflow",
      rule: "computed_from_input",
      mode: "no_confirm",
      outcome: "proceed",
      surface: "web",
      conversation_id: conversationId,
    });
  });
});
