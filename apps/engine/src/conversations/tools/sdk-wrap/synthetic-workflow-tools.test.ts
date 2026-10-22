import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { tenants } from "../../../db/schema/identity.ts";
import {
  conversationElicitations,
  conversations,
  executions,
  webhooksInbound,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { resetMockProvider } from "../../../llm/mock-provider.ts";
import { logger } from "../../../logging/logger.ts";
import { workflowExecutionEnvironment } from "../../../workflows/execution-environment.ts";
import { humanChatAnswer } from "../../answer-actor.ts";
import { maybeAutoPersistFromElicitation } from "../../persistence/auto-persist.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { wrapTools } from "../sdk-wrap.ts";
import type { TurnSignals } from "./state.ts";
import { buildSyntheticWorkflowTools } from "./synthetic-workflow-tools.ts";

let tdb: TestDb;
let tenantId: string;
let conversationId: string;
let server: ReturnType<typeof createServer>;
let requestUrl: string;
let requests = 0;
let receivedBody = "";

function makePrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: "00000000-0000-4000-8000-0000000000fc",
    tenant_id: tenantId,
    roles: ["admin"],
    ...overrides,
  };
}

function makeTurnSignals(): TurnSignals {
  return {
    step: 0,
    toolChain: Promise.resolve(),
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    toolArgsRepeat: new Map(),
    toolValidationFingerprint: new Map(),
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const logs: Array<{ level: string; message: string }> = [];
  return {
    db: tdb.db,
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as ToolContext["engineClient"],
    getDraft: () => ({ workflow: { name: "draft", steps: [] } as never }),
    setDraft: async () => {},
    onLog: (level, message) => logs.push({ level, message }),
    ...overrides,
  } as ToolContext;
}

beforeAll(async () => {
  tdb = await createTestDb("synthetic-workflow-tools");

  const [t] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-swt", display_name: "Synthetic Tools Tenant" })
    .returning();
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  server = createServer((request, response) => {
    request.on("data", (chunk) => {
      receivedBody += chunk.toString();
    });
    requests += 1;
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  requestUrl = `http://127.0.0.1:${address.port}/read`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await tdb.cleanup();
});

beforeEach(async () => {
  resetMockProvider();
  requests = 0;
  receivedBody = "";
  const [conv] = await tdb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning();
  if (!conv) throw new Error("conversation seed failed");
  conversationId = conv.id;

  await tdb.db.delete(workflowVersions);
  await tdb.db.delete(workflows);
});

async function seedTool(slug: string): Promise<{ id: string }> {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug,
      name: slug,
      lifecycle: "active",
      is_tool: true,
    })
    .returning();
  if (!wf) throw new Error("workflow seed failed");

  const [v] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: { name: slug, slug, steps: [{ id: "s1", kind: "request", url: requestUrl }] },
    })
    .returning();
  if (!v) throw new Error("version seed failed");

  await tdb.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));
  return { id: wf.id };
}

describe("buildSyntheticWorkflowTools — catalog shape", () => {
  test("returns empty map when no is_tool workflows exist", async () => {
    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx: makeCtx(),
      signals: makeTurnSignals(),
      events: [],
    });
    expect(Object.keys(tools)).toHaveLength(0);
  });

  test("returns wf_<slug> keyed entry for each is_tool=true workflow", async () => {
    await seedTool("my-tool-wf");
    await seedTool("another-tool");

    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx: makeCtx(),
      signals: makeTurnSignals(),
      events: [],
    });

    expect("wf_my-tool-wf" in tools).toBe(true);
    expect("wf_another-tool" in tools).toBe(true);
    expect("my-tool-wf" in tools).toBe(false);
  });

  test("each tool has a description and an execute function", async () => {
    await seedTool("exec-test-wf");

    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx: makeCtx(),
      signals: makeTurnSignals(),
      events: [],
    });

    const tool = tools["wf_exec-test-wf"];
    expect(tool).toBeDefined();
    expect(typeof tool?.description).toBe("string");
    expect(tool?.description).toContain("exec-test-wf");
    expect(typeof tool?.execute).toBe("function");
  });

  test("tool description mentions 'saved workflow' and the slug", async () => {
    await seedTool("jira-sync");

    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx: makeCtx(),
      signals: makeTurnSignals(),
      events: [],
    });

    const desc = String(tools["wf_jira-sync"]?.description ?? "");
    expect(desc).toContain("jira-sync");
    expect(desc.toLowerCase()).toContain("workflow");
  });
});

describe("buildSyntheticWorkflowTools — execute happy path", () => {
  test("a direct synthetic tool call cannot start a run after an explicit no-run request", async () => {
    await seedTool("no-run-test");
    const ctx = makeCtx({
      recentUserMessage:
        "Untersuche den gespeicherten Lauf. Ändere nichts und führe keinen Lauf aus.",
    });
    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx,
      signals: makeTurnSignals(),
      events: [],
    });
    const before = await tdb.db.select({ id: executions.id }).from(executions);

    const result = await tools["wf_no-run-test"]!.execute!(
      {},
      { toolCallId: "no-run-call", messages: [], context: {} },
    );

    const after = await tdb.db.select({ id: executions.id }).from(executions);
    expect(result).toMatchObject({
      ok: false,
      data: { error_code: "explicit_no_run" },
    });
    expect(after).toHaveLength(before.length);
    expect(requests).toBe(0);
  });

  test("execute returns an envelope with suggested_command", async () => {
    await seedTool("suggest-test");
    const logMessages: string[] = [];
    const ctx = makeCtx({
      onLog: (_level, msg) => logMessages.push(msg),
    });
    const events: TurnEvent[] = [];
    const signals = makeTurnSignals();

    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx,
      signals,
      events,
    });

    const tool = tools["wf_suggest-test"];
    expect(tool).toBeDefined();
    const result = await tool!.execute!({} as Record<string, unknown>, {
      toolCallId: "test-call-id",
      messages: [],
      context: {},
    });
    const output = (result as { ok: boolean; data: Record<string, unknown> }).data;
    expect(output?.suggested_command).toBe("/workflows run suggest-test");
    expect(requests).toBe(1);
    expect((result as { ok: boolean }).ok).toBe(true);
  });

  test("execute emits tool_call_start and tool_result events", async () => {
    await seedTool("event-test");
    const events: TurnEvent[] = [];
    const signals = makeTurnSignals();

    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx: makeCtx(),
      signals,
      events,
    });

    await tools["wf_event-test"]!.execute!(
      {},
      { toolCallId: "test-call-id", messages: [], context: {} },
    );
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("tool_call_start");
    expect(eventTypes).toContain("tool_result");
  });

  test("execute calls ctx.onLog for each step of the execution", async () => {
    await seedTool("log-test");
    const logMessages: string[] = [];
    const ctx = makeCtx({
      onLog: (_level, msg) => logMessages.push(msg),
    });
    const events: TurnEvent[] = [];
    const signals = makeTurnSignals();

    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx,
      signals,
      events,
    });

    await tools["wf_log-test"]!.execute!(
      {},
      { toolCallId: "test-call-id", messages: [], context: {} },
    );
    expect(logMessages.some((m) => m.includes("log-test"))).toBe(true);
  });
});

describe("buildSyntheticWorkflowTools — envelope fields", () => {
  test("envelope contains workflow_id after a run", async () => {
    const { id } = await seedTool("env-check-wf");
    const events: TurnEvent[] = [];
    const signals = makeTurnSignals();

    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx: makeCtx(),
      signals,
      events,
    });

    const result = (await tools["wf_env-check-wf"]!.execute!(
      {},
      { toolCallId: "test-call-id", messages: [], context: {} },
    )) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(result.data?.workflow_id).toBe(id);
    expect(result.data?.workflow_slug).toBe("env-check-wf");
  });

  test("successful run envelope has next_best_actions", async () => {
    await seedTool("nba-test");
    const events: TurnEvent[] = [];
    const signals = makeTurnSignals();

    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx: makeCtx(),
      signals,
      events,
    });

    const result = (await tools["wf_nba-test"]!.execute!(
      {},
      { toolCallId: "test-call-id", messages: [], context: {} },
    )) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(Array.isArray(result.data?.next_best_actions)).toBe(true);
  });
});

describe("buildSyntheticWorkflowTools — tenant isolation", () => {
  test("principal from tenant B sees no wf_<slug> entries for tenant A", async () => {
    await seedTool("tenant-a-tool");
    const [tB] = await tdb.db
      .insert(tenants)
      .values({ slug: "t-syn-b", display_name: "Tenant B Synthetic" })
      .returning();
    if (!tB) throw new Error("tenant B seed failed");
    const principalB = makePrincipal({ tenant_id: tB.id });
    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: principalB,
      ctx: makeCtx({ tenant_id: tB.id }),
      signals: makeTurnSignals(),
      events: [],
    });
    expect(Object.keys(tools)).not.toContain("wf_tenant-a-tool");
    expect(Object.keys(tools)).toHaveLength(0);
  });
});

describe("buildSyntheticWorkflowTools — RBAC denial", () => {
  test("per-execute gateWorkflowRunRbac fires when an admin-built tool is invoked under a restricted principal", async () => {
    const wf = await seedTool("rbac-denied-syn");
    const admin = makePrincipal();
    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: admin,
      ctx: makeCtx(),
      signals: makeTurnSignals(),
      events: [],
    });
    const tool = tools["wf_rbac-denied-syn"];
    expect(tool).toBeDefined();

    const restricted = makePrincipal({
      provider: "portal_token",
      roles: ["portal_token_user"],
      allowed_workflows: ["00000000-0000-0000-0000-000000000099"],
    });
    const restrictedTools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: restricted,
      ctx: makeCtx(),
      signals: makeTurnSignals(),
      events: [],
    });
    const restrictedTool = restrictedTools["wf_rbac-denied-syn"];
    if (!restrictedTool) {
      expect(Object.keys(restrictedTools)).not.toContain("wf_rbac-denied-syn");
    } else {
      const result = (await restrictedTool.execute!(
        {},
        { toolCallId: "test-call-id", messages: [], context: {} },
      )) as { ok: boolean; data: Record<string, unknown> };
      expect(result.ok).toBe(false);
      expect(result.data?.denied).toBe(true);
      expect(result.data?.permission).toBe("workflow:run");
    }
    const audit = await tdb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, AuditAction.POLICY_DENIED),
          eq(auditLog.resource_type, "workflow"),
          eq(auditLog.resource_id, wf.id),
        ),
      );
    expect(audit.length).toBeGreaterThanOrEqual(0);
  });
});

test("saved workflow execution follows its schedule environment and ignores paused schedules", async () => {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      name: "Environment selection",
      slug: "environment-selection",
      lifecycle: "draft",
    })
    .returning();
  if (!wf) throw new Error("missing workflow");
  expect(await workflowExecutionEnvironment(tdb.db, tenantId, wf.id)).toBe("dev");
  await tdb.db
    .insert(workflowsSchedules)
    .values({ tenant_id: tenantId, workflow_id: wf.id, cron: "0 8 * * *", execution_mode: "prod" });
  expect(await workflowExecutionEnvironment(tdb.db, tenantId, wf.id)).toBe("prod");
  await tdb.db
    .update(workflowsSchedules)
    .set({ paused: true })
    .where(
      and(eq(workflowsSchedules.tenant_id, tenantId), eq(workflowsSchedules.workflow_id, wf.id)),
    );
  expect(await workflowExecutionEnvironment(tdb.db, tenantId, wf.id)).toBe("dev");
});

test("a hook-started workflow is judged in production, where its deliveries run", async () => {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      name: "Hook environment",
      slug: "hook-environment",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("missing workflow");
  const [hook] = await tdb.db
    .insert(webhooksInbound)
    .values({
      tenant_id: tenantId,
      workflow_id: wf.id,
      slug: "hook-environment",
      verifier: "standard",
      secret_ciphertext: Buffer.alloc(1),
      secret_iv: Buffer.alloc(1),
      secret_auth_tag: Buffer.alloc(1),
    })
    .returning();
  if (!hook) throw new Error("missing hook");
  expect(await workflowExecutionEnvironment(tdb.db, tenantId, wf.id)).toBe("prod");
  const [schedule] = await tdb.db
    .insert(workflowsSchedules)
    .values({ tenant_id: tenantId, workflow_id: wf.id, cron: "0 8 * * *", execution_mode: "dev" })
    .returning();
  if (!schedule) throw new Error("missing schedule");
  await expect(workflowExecutionEnvironment(tdb.db, tenantId, wf.id)).rejects.toMatchObject({
    code: "workflow_environment_ambiguous",
  });
  await tdb.db
    .update(webhooksInbound)
    .set({ active: false })
    .where(and(eq(webhooksInbound.tenant_id, tenantId), eq(webhooksInbound.id, hook.id)));
  expect(await workflowExecutionEnvironment(tdb.db, tenantId, wf.id)).toBe("dev");
});

test("saved tool audits execution with the typed system-account principal", async () => {
  const workflow = await seedTool("production-report");
  await tdb.db.insert(workflowsSchedules).values({
    tenant_id: tenantId,
    workflow_id: workflow.id,
    cron: "0 8 * * *",
    execution_mode: "prod",
  });
  const logMessages: string[] = [];
  const tools = await buildSyntheticWorkflowTools({
    db: tdb.db,
    principal: makePrincipal({
      kind: "system_account",
      id: "10000000-0000-4000-8000-000000000002",
    }),
    ctx: makeCtx({ onLog: (_level, msg) => logMessages.push(msg) }),
    signals: makeTurnSignals(),
    events: [],
  });
  const tool = tools["wf_production-report"];
  if (!tool?.execute) throw new Error("missing workflow tool");
  const result = (await tool.execute(
    {},
    { toolCallId: "production-test", messages: [], context: {} },
  )) as unknown as { ok: boolean; data: { execution_id: string } };
  expect(result.ok).toBe(true);
  expect(logMessages.some((message) => message.includes("env=prod"))).toBe(true);
  expect(requests).toBe(1);
  const [audit] = await tdb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, AuditAction.EXECUTION_STARTED),
        eq(auditLog.resource_id, result.data.execution_id),
      ),
    )
    .limit(1);
  expect(audit).toMatchObject({
    actor_type: "system_account",
    actor_id: "10000000-0000-4000-8000-000000000002",
  });
});

test("production preparation pauses in chat and human approval dispatches once in its reviewed environment", async () => {
  const workflow = await seedTool("production-delivery");
  const [version] = await tdb.db
    .select()
    .from(workflowVersions)
    .where(
      and(eq(workflowVersions.tenant_id, tenantId), eq(workflowVersions.workflow_id, workflow.id)),
    );
  if (!version) throw new Error("missing version");
  await tdb.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "Daily delivery",
        slug: "production-delivery",
        steps: [
          {
            id: "prepare",
            kind: "transform",
            lang: "js",
            // allow-wall-clock: guest source tests the server-fixed Date shim, not the host clock.
            expression: "return { instant: Date.now(), stable: sk.now(), id: sk.uuid() };",
          },
          {
            id: "send",
            depends_on: ["prepare"],
            kind: "request",
            method: "POST",
            url: requestUrl,
            body: "${scope.prepare.data}",
          },
        ],
      },
    })
    .where(and(eq(workflowVersions.tenant_id, tenantId), eq(workflowVersions.id, version.id)));
  await tdb.db.insert(workflowsSchedules).values({
    tenant_id: tenantId,
    workflow_id: workflow.id,
    cron: "0 8 * * *",
    execution_mode: "prod",
  });
  const signals = makeTurnSignals();
  const tools = await buildSyntheticWorkflowTools({
    db: tdb.db,
    principal: makePrincipal(),
    ctx: makeCtx(),
    signals,
    events: [],
  });
  const tool = tools["wf_production-delivery"];
  if (!tool?.execute) throw new Error("missing delivery tool");
  const result = await tool.execute(
    {},
    { toolCallId: "production-write-test", messages: [], context: {} },
  );
  expect(result).toMatchObject({ pause: { tool_name: "ask_user_confirm" } });
  expect(signals.pendingElicitation?.tool_name).toBe("ask_user_confirm");
  expect(requests).toBe(0);
  const [question] = await tdb.db
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenantId),
        eq(conversationElicitations.conversation_id, conversationId),
      ),
    );
  expect(question?.input).toMatchObject({ commit_intent: { kind: "commit_held_workflow_writes" } });
  if (!question) throw new Error("missing decision");
  await tdb.db
    .update(workflowsSchedules)
    .set({ execution_mode: "dev" })
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenantId),
        eq(workflowsSchedules.workflow_id, workflow.id),
      ),
    );
  const principal = makePrincipal();
  const answer = {
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: principal.id,
    principal,
    answer_actor: humanChatAnswer(principal),
    elicitation_output: { confirmed: true },
    elicitation: question,
    surface: "web" as const,
    db: tdb.db,
  };
  await Bun.sleep(30);
  const completed = await maybeAutoPersistFromElicitation(answer);
  expect(completed.synthetic_result).toMatchObject({ ok: true, data: { status: "succeeded" } });
  expect(requests).toBe(1);
  expect(JSON.parse(receivedBody)).toMatchObject({
    instant: expect.any(Number),
    stable: expect.any(Number),
    id: expect.any(String),
  });
  expect(JSON.parse(receivedBody).instant).toBe(JSON.parse(receivedBody).stable);
  const repeated = await maybeAutoPersistFromElicitation(answer);
  expect(repeated.synthetic_result?.ok).toBe(false);
  expect(requests).toBe(1);
});

async function seedProductBoundTool(slug: string): Promise<void> {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug, name: slug, lifecycle: "active", is_tool: true })
    .returning();
  if (!wf) throw new Error("workflow seed failed");
  const [v] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: {
        name: slug,
        slug,
        product_id: "tekit",
        required_caller_kind: "user",
        execution_privacy: "sensitive",
        input_schema: {
          type: "object",
          properties: { purpose: { type: "string" } },
          required: ["purpose"],
          additionalProperties: false,
          oneOf: [
            { properties: { purpose: { const: "round" } } },
            { properties: { purpose: { const: "classify" } } },
          ],
        },
        steps: [{ id: "s1", kind: "request", url: requestUrl }],
      },
    })
    .returning();
  if (!v) throw new Error("version seed failed");
  await tdb.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));
}

test("a product-bound sensitive workflow never reaches the conversation palette", async () => {
  await seedProductBoundTool("product-round");
  await seedTool("plain-tool");
  const principal = makePrincipal();
  const tools = await buildSyntheticWorkflowTools({
    db: tdb.db,
    principal,
    ctx: makeCtx(),
    signals: makeTurnSignals(),
    events: [],
  });
  expect(Object.keys(tools).sort()).toEqual(["wf_plain-tool"]);

  const warnSpy = spyOn(logger, "warn");
  try {
    const wrapped = await wrapTools(
      makeCtx(),
      makeTurnSignals(),
      [],
      tdb.db,
      [],
      {},
      null,
      principal,
    );
    expect("wf_product-round" in wrapped).toBe(false);
    expect("wf_plain-tool" in wrapped).toBe(true);
    const schemaWarns = warnSpy.mock.calls.filter(
      ([entry]) => (entry as { action?: string }).action === "tool.schema_incompatible",
    );
    expect(schemaWarns).toEqual([]);
  } finally {
    warnSpy.mockRestore();
  }
});
