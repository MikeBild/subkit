import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, eq, isNull } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { MCP_ADMIN_SCOPE } from "../../auth/scopes.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import { freshSignals } from "../../conversations/tests/turn-signals.ts";
import { getTool, type ToolContext } from "../../conversations/tools/index.ts";
import { wrapOne } from "../../conversations/tools/sdk-wrap/invoke.ts";
import type { TurnEvent } from "../../conversations/types.ts";
import {
  auditLog,
  conversationMessages,
  conversations,
  conversationToolCalls,
  knowledgeSources,
  mcpTasks,
  toolApprovals,
  workflows,
} from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { getMetrics, METRIC_NAMES } from "../../observability/metrics.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { makeToolCtx } from "../../test-helpers/seed.ts";
import { hashToolArgs } from "../../tools/approval.ts";
import { replayHumanGrantedMcpCall } from "./approved-call-fixture.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

const ARGS = { slug: "parity-target" };
const ARGS_HASH = hashToolArgs(ARGS);
const CONFIRM_DECISION = "permission_mode|confirm_before_execution|confirm";
const PROCEED_DECISION = "permission_mode|no_confirm|proceed";

let suite: McpTestSuite;
let adminClient: Client;
let approvalClient: Client;
let principal: ResolvedPrincipal;
let approvalRequests = 0;
let targetWorkflowId = "";
let previousPublicBaseUrl = "";
const previousLlmProvider = process.env.LLM_PROVIDER;

const phase: {
  loopWebApprovalId: string;
  loopHeadlessApprovalId: string;
  routeApprovalId: string;
  routePending: Awaited<ReturnType<Client["callTool"]>> | null;
  askConversationId: string;
  askApprovalId: string;
} = {
  loopWebApprovalId: "",
  loopHeadlessApprovalId: "",
  routeApprovalId: "",
  routePending: null,
  askConversationId: "",
  askApprovalId: "",
};

function parseEnvelope(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const item = (result.content as Array<{ type: string; text?: string }>)[0];
  return JSON.parse(item?.type === "text" ? (item.text ?? "{}") : "{}") as Record<string, unknown>;
}

function toolCtx(conversation_id: string, surface: "web" | "sk_headless"): ToolContext {
  return makeToolCtx({
    db: suite.http.db,
    tenant_id: suite.http.tenantId,
    conversation_id,
    actor_id: suite.http.userId,
    principal,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
    surface,
  });
}

async function runLoopTool(
  tool: string,
  surface: "web" | "sk_headless",
  args: Record<string, unknown>,
): Promise<{ conversationId: string; result: unknown }> {
  const conversationId = await newConversation();
  const inner = getTool(tool);
  if (!inner) throw new Error(`${tool} is not registered`);
  const events: TurnEvent[] = [];
  const wrapped = wrapOne(
    inner,
    toolCtx(conversationId, surface),
    freshSignals(),
    events,
    suite.http.db,
    {},
    "auto",
    [],
  );
  const result = await wrapped.execute!(args, {
    toolCallId: `parity-${surface}-${tool}`,
    messages: [],
    context: {},
  });
  return { conversationId, result };
}

async function newConversation(): Promise<string> {
  const [row] = await suite.http.db
    .insert(conversations)
    .values({ tenant_id: suite.http.tenantId, owner_id: suite.http.userId, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation seed failed");
  return row.id;
}

function decisionSamples(): Map<string, number> {
  const out = new Map<string, number>();
  const series = getMetrics()
    .snapshot()
    .find((s) => s.name === METRIC_NAMES.TOOL_POLICY_DECISION_TOTAL);
  for (const s of series?.samples ?? []) {
    out.set(`${s.labels.rule}|${s.labels.mode}|${s.labels.outcome}|${s.labels.surface}`, s.value);
  }
  return out;
}

async function decisionDelta<T>(run: () => Promise<T>): Promise<{
  value: T;
  delta: Record<string, number>;
}> {
  const before = decisionSamples();
  const value = await run();
  const delta: Record<string, number> = {};
  for (const [key, count] of decisionSamples()) {
    const d = count - (before.get(key) ?? 0);
    if (d !== 0) delta[key] = d;
  }
  return { value, delta };
}

async function approvalsFor(tool: string) {
  return suite.http.db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, suite.http.tenantId), eq(toolApprovals.tool, tool)))
    .orderBy(toolApprovals.created_at);
}

async function approvalRow(id: string) {
  const [row] = await suite.http.db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, suite.http.tenantId), eq(toolApprovals.id, id)));
  if (!row) throw new Error(`approval ${id} missing`);
  return row;
}

async function auditRows(action: string, resourceId: string) {
  return suite.http.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, suite.http.tenantId),
        eq(auditLog.action, action),
        eq(auditLog.resource_id, resourceId),
      ),
    );
}

async function confirmationRequiredCount(): Promise<number> {
  const rows = await suite.http.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, suite.http.tenantId),
        eq(auditLog.action, AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED),
      ),
    );
  return rows.length;
}

async function targetWorkflowDeletedAt(): Promise<Date | null> {
  const [row] = await suite.http.db
    .select({ deleted_at: workflows.deleted_at })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, suite.http.tenantId), eq(workflows.id, targetWorkflowId)));
  if (!row) throw new Error("parity-target workflow missing");
  return row.deleted_at;
}

async function expectLoopGate(approvalId: string, conversationId: string): Promise<void> {
  const row = await approvalRow(approvalId);
  expect(row.args_hash).toBe(ARGS_HASH);
  expect(row.surface).toBe("chat");
  expect(row.principal_id).toBe(suite.http.userId);
  expect(row.granted_at).toBeNull();
  const requested = await auditRows(AuditAction.APPROVAL_REQUESTED, approvalId);
  expect(requested).toHaveLength(1);
  expect(requested[0]?.resource_type).toBe("conversation_tool_call");
  expect(requested[0]?.metadata).toMatchObject({ resolver_reason: "permission_mode" });
  expect(
    await auditRows(AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED, conversationId),
  ).toHaveLength(1);
}

async function waitForAppendTask(conversationId: string): Promise<void> {
  await waitFor(
    async () => {
      const [row] = await suite.http.db
        .select()
        .from(mcpTasks)
        .where(
          and(
            eq(mcpTasks.tenant_id, suite.http.tenantId),
            eq(mcpTasks.conversation_id, conversationId),
          ),
        );
      if (!row) return null;
      if (row.failure_reason) throw new Error(`MCP task failed: ${row.failure_reason}`);
      return row.result ? row : null;
    },
    { tries: 500, sleepMs: 10, label: "mcp append task completion" },
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
          ),
        );
      if (row?.kind !== "respond_elicitation") return null;
      if (row.failure_reason) throw new Error(`resumed MCP task failed: ${row.failure_reason}`);
      return row.result ? row : null;
    },
    { tries: 500, sleepMs: 10, label: "resumed MCP task completion" },
  );
}

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  suite = await startMcpTestSuite("confirm-gate-parity-http", { withQueue: true });
  previousPublicBaseUrl = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", suite.http.baseUrl, { force: true });
  principal = {
    provider: "test",
    kind: "user",
    id: suite.http.userId,
    tenant_id: suite.http.tenantId,
    roles: ["admin"],
  };
  const admin = await suite.issueApiKey([MCP_ADMIN_SCOPE]);
  adminClient = await suite.connectWithApiKey(admin.plaintext);
  approvalClient = await suite.connectElicitation(async (request) => {
    approvalRequests += 1;
    expect(request.params.mode).toBe("form");
    return { action: "accept", content: { confirmed: true } };
  });
  const target = await suite.seedWorkflow({
    name: "Parity target",
    slug: ARGS.slug,
    steps: [{ id: "wait", kind: "wait", duration_ms: 1 }],
  });
  targetWorkflowId = target.id;
}, 30_000);

afterAll(async () => {
  await setConfigKey("server.public_base_url", previousPublicBaseUrl, { force: true });
  if (previousLlmProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousLlmProvider;
  await suite?.cleanup();
}, 30_000);

describe("confirm gate parity through the real MCP route — delete_workflow", () => {
  test("phase 1 — loop on web under auto pauses on one permission_mode approval", async () => {
    const { value, delta } = await decisionDelta(() => runLoopTool("delete_workflow", "web", ARGS));
    expect(value.result).toMatchObject({ ok: false, pause: { tool_name: "ask_user_confirm" } });
    expect(delta).toEqual({ [`${CONFIRM_DECISION}|web`]: 1 });

    const rows = await approvalsFor("delete_workflow");
    expect(rows).toHaveLength(1);
    phase.loopWebApprovalId = rows[0]!.id;
    await expectLoopGate(phase.loopWebApprovalId, value.conversationId);
  });

  test("phase 2 — loop on sk_headless under auto opens a second row with the same args_hash", async () => {
    const { value, delta } = await decisionDelta(() =>
      runLoopTool("delete_workflow", "sk_headless", ARGS),
    );
    expect(value.result).toMatchObject({ ok: false, pause: { tool_name: "ask_user_confirm" } });
    expect(delta).toEqual({ [`${CONFIRM_DECISION}|sk_headless`]: 1 });

    const rows = await approvalsFor("delete_workflow");
    expect(rows).toHaveLength(2);
    phase.loopHeadlessApprovalId = rows[1]!.id;
    expect(phase.loopHeadlessApprovalId).not.toBe(phase.loopWebApprovalId);
    await expectLoopGate(phase.loopHeadlessApprovalId, value.conversationId);
  });

  test("phase 3 — real tools/call answers needs_confirm with the same args_hash and no conversation audit", async () => {
    const requiredBefore = await confirmationRequiredCount();
    const { value: pending, delta } = await decisionDelta(() =>
      adminClient.callTool({ name: "delete_workflow", arguments: ARGS }),
    );
    expect(pending.isError).toBeFalsy();
    const body = parseEnvelope(pending) as {
      status?: string;
      tool?: string;
      reason?: string;
      policy_mode?: string;
      tool_call_id?: string;
      approval_url?: string | null;
      resume?: string;
    };
    expect(body.status).toBe("needs_confirm");
    expect(body.tool).toBe("delete_workflow");
    expect(body.reason).toBe("permission_mode");
    expect(body.policy_mode).toBe("confirm_before_execution");
    const toolCallId = body.tool_call_id;
    if (!toolCallId) throw new Error("needs_confirm envelope carried no tool_call_id");
    expect(toolCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(body.approval_url)).toStartWith(suite.http.baseUrl);
    expect(body.resume).toContain("confirm_tool_call");
    expect(
      (pending._meta as { subkit?: { confirm?: { tool_call_id?: string } } } | undefined)?.subkit
        ?.confirm?.tool_call_id,
    ).toBe(toolCallId);
    expect(delta).toEqual({ [`${CONFIRM_DECISION}|mcp`]: 1 });

    const rows = await approvalsFor("delete_workflow");
    expect(rows).toHaveLength(3);
    const row = rows[2]!;
    expect(row.id).toBe(toolCallId);
    expect(row.args_hash).toBe(ARGS_HASH);
    expect(row.surface).toBe("mcp");
    expect(row.granted_at).toBeNull();
    phase.routeApprovalId = row.id;
    phase.routePending = pending;

    const requested = await auditRows(AuditAction.APPROVAL_REQUESTED, row.id);
    expect(requested).toHaveLength(1);
    expect(requested[0]?.resource_type).toBe("mcp_tool_call");
    expect(requested[0]?.metadata).toMatchObject({ resolver_reason: "permission_mode" });
    expect(await confirmationRequiredCount()).toBe(requiredBefore);
    expect(await targetWorkflowDeletedAt()).toBeNull();
  });

  test("phase 4 — conversation_append under ask pauses the loop on a fourth row and raises a native elicitation", async () => {
    const conversationId = await newConversation();
    phase.askConversationId = conversationId;
    getMockProvider().setConversePlan(conversationId, [{ tool: "delete_workflow", args: ARGS }]);

    const { value: append, delta } = await decisionDelta(async () => {
      const result = await approvalClient.callTool({
        name: "conversation_append",
        arguments: {
          conversation_id: conversationId,
          message: "Remove the parity target, please.",
        },
        _meta: { sk_permission_mode: "ask" },
      });
      await waitFor(
        async () => {
          const [row] = await suite.http.db
            .select({ status: conversations.status })
            .from(conversations)
            .where(
              and(
                eq(conversations.tenant_id, suite.http.tenantId),
                eq(conversations.id, conversationId),
              ),
            );
          return row?.status === "awaiting_input" ? row : null;
        },
        { tries: 500, sleepMs: 10, label: "ask-mode approval pause" },
      );
      return result;
    });
    expect(append.isError).toBe(false);
    expect(parseEnvelope(append)).toMatchObject({
      conversation_id: conversationId,
      status: "working",
    });
    expect(delta).toEqual({ [`${CONFIRM_DECISION}|mcp`]: 1 });
    expect(approvalRequests).toBe(0);

    const rows = await approvalsFor("delete_workflow");
    expect(rows).toHaveLength(4);
    phase.askApprovalId = rows[3]!.id;
    await expectLoopGate(phase.askApprovalId, conversationId);
    expect(new Set(rows.map((r) => r.args_hash))).toEqual(new Set([ARGS_HASH]));
    expect(rows.map((r) => r.surface)).toEqual(["chat", "chat", "mcp", "chat"]);
    expect(await targetWorkflowDeletedAt()).toBeNull();
  }, 30_000);

  test("phase 5 — a human grant replays the MCP call once: deleted, consumed, granted and approved audited once", async () => {
    if (!phase.routePending) throw new Error("phase 3 did not record the pending call");
    const replayed = await replayHumanGrantedMcpCall(suite, adminClient, phase.routePending);
    expect(replayed.isError).toBeFalsy();
    expect(parseEnvelope(replayed)).toMatchObject({
      deleted: true,
      workflow: { id: targetWorkflowId, slug: ARGS.slug },
    });

    expect(await targetWorkflowDeletedAt()).toBeInstanceOf(Date);
    const row = await approvalRow(phase.routeApprovalId);
    expect(row.granted_at).toBeInstanceOf(Date);
    expect(row.granted_via).toBe("portal");
    expect(row.granted_by_user_id).toBe(suite.http.userId);
    expect(row.consumed_at).toBeInstanceOf(Date);
    expect(await auditRows(AuditAction.APPROVAL_GRANTED, phase.routeApprovalId)).toHaveLength(1);
    expect(await auditRows(AuditAction.APPROVAL_APPROVED, phase.routeApprovalId)).toHaveLength(1);

    for (const untouched of [
      phase.loopWebApprovalId,
      phase.loopHeadlessApprovalId,
      phase.askApprovalId,
    ]) {
      const other = await approvalRow(untouched);
      expect(other.granted_at).toBeNull();
      expect(other.consumed_at).toBeNull();
    }

    const duplicate = await adminClient.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "delete_workflow", confirm_id: phase.routeApprovalId },
    });
    expect(duplicate.isError).toBe(true);
    expect(await auditRows(AuditAction.APPROVAL_APPROVED, phase.routeApprovalId)).toHaveLength(1);
  });

  test("phase 6 — the native accept resumes the ask-mode loop exactly once and the held delete reports workflow_not_found", async () => {
    const conversationId = phase.askConversationId;
    const delivery = await approvalClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversationId },
    });
    expect(parseEnvelope(delivery).status).toBe("input_required");
    await waitForResumedTask(conversationId);
    expect(approvalRequests).toBe(1);

    const row = await approvalRow(phase.askApprovalId);
    expect(row.granted_at).toBeInstanceOf(Date);
    expect(row.granted_via).toBe("in_band_elicitation");
    expect(row.granted_by_user_id).toBe(suite.http.userId);
    expect(row.consumed_at).toBeInstanceOf(Date);
    expect(await auditRows(AuditAction.APPROVAL_GRANTED, phase.askApprovalId)).toHaveLength(1);
    expect(await auditRows(AuditAction.APPROVAL_APPROVED, phase.askApprovalId)).toHaveLength(1);

    const calls = await suite.http.db
      .select({ input: conversationToolCalls.input, output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, suite.http.tenantId),
          eq(conversationToolCalls.conversation_id, conversationId),
          eq(conversationToolCalls.tool, "delete_workflow"),
        ),
      );
    const released = calls.find(
      (c) => (c.input as { _harness_auto_persist?: boolean })._harness_auto_persist === true,
    );
    expect(released?.output).toMatchObject({ ok: false, data: { error: "workflow_not_found" } });

    const completed = await approvalClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversationId },
    });
    expect(parseEnvelope(completed).status).toBe("completed");
    expect(approvalRequests).toBe(1);
    expect(await approvalsFor("delete_workflow")).toHaveLength(4);
  }, 30_000);
});

describe("confirm gate parity through the real MCP route — create_knowledge_source under auto", () => {
  const sourceName = (path: string) => `Parity source ${path}`;
  const sourceArgs = (path: string) => ({
    mode: "inline",
    name: sourceName(path),
    content: `# Parity ${path}`,
  });

  async function sourceRows(name: string) {
    return suite.http.db
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenant_id, suite.http.tenantId),
          eq(knowledgeSources.name, name),
          isNull(knowledgeSources.deleted_at),
        ),
      );
  }

  test("loop on web and sk_headless: the preparation write runs with no approval row", async () => {
    for (const surface of ["web", "sk_headless"] as const) {
      const { value, delta } = await decisionDelta(() =>
        runLoopTool("create_knowledge_source", surface, sourceArgs(surface)),
      );
      expect(value.result).toMatchObject({ ok: true });
      expect(delta).toEqual({ [`${PROCEED_DECISION}|${surface}`]: 1 });
      expect(await sourceRows(sourceName(surface))).toHaveLength(1);
    }
    expect(await approvalsFor("create_knowledge_source")).toHaveLength(0);
  });

  test("real tools/call: the same write runs inline with no approval row", async () => {
    const { value, delta } = await decisionDelta(() =>
      adminClient.callTool({ name: "create_knowledge_source", arguments: sourceArgs("mcp") }),
    );
    expect(value.isError).toBeFalsy();
    expect(parseEnvelope(value)).toMatchObject({
      created: true,
      knowledge_source: { name: sourceName("mcp") },
    });
    expect(delta).toEqual({ [`${PROCEED_DECISION}|mcp`]: 1 });
    expect(await sourceRows(sourceName("mcp"))).toHaveLength(1);
    expect(await approvalsFor("create_knowledge_source")).toHaveLength(0);
  });

  test("conversation_append under auto: the loop runs the write to completion with no approval row", async () => {
    const conversationId = await newConversation();
    getMockProvider().setConversePlan(conversationId, [
      { tool: "create_knowledge_source", args: sourceArgs("conversation") },
    ]);
    const { value, delta } = await decisionDelta(async () => {
      const result = await adminClient.callTool({
        name: "conversation_append",
        arguments: {
          conversation_id: conversationId,
          message: "Capture the parity notes as a knowledge source.",
        },
        _meta: { sk_permission_mode: "auto" },
      });
      await waitForAppendTask(conversationId);
      return result;
    });
    expect(value.isError).toBe(false);
    expect(delta).toEqual({ [`${PROCEED_DECISION}|mcp`]: 1 });
    expect(await sourceRows(sourceName("conversation"))).toHaveLength(1);
    expect(await approvalsFor("create_knowledge_source")).toHaveLength(0);
    expect(approvalRequests).toBe(1);

    const [status] = await suite.http.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(
        and(eq(conversations.tenant_id, suite.http.tenantId), eq(conversations.id, conversationId)),
      );
    expect(status?.status).not.toBe("awaiting_input");
    const messages = await suite.http.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, suite.http.tenantId),
          eq(conversationMessages.conversation_id, conversationId),
        ),
      );
    expect(messages.length).toBeGreaterThan(0);
  }, 30_000);
});
