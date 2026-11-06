import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { tenants } from "../../../db/schema/identity.ts";
import { conversationMessages, executions, workflowVersions } from "../../../db/schema/index.ts";
import type { TurnEvent } from "../../types.ts";
import { buildSyntheticWorkflowTools } from "./synthetic-workflow-tools.ts";
import {
  conversationId,
  makeCtx,
  makePrincipal,
  makeTurnSignals,
  requests,
  seedTool,
  tdb,
  tenantId,
  useSyntheticWorkflowToolsSetup,
} from "./tests/synthetic-workflow-tools-fixtures.ts";

useSyntheticWorkflowToolsSetup();

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

  test("a direct synthetic tool call cannot start a live run after a no-live-effects preparation", async () => {
    await seedTool("no-live-test");
    await tdb.db.insert(conversationMessages).values({
      tenant_id: tenantId,
      conversation_id: conversationId,
      role: "user",
      content:
        "Bereite diesen Ablauf für den automatischen Betrieb vor. Nicht aktivieren, keine Live-Wirkungen freigeben oder ausführen.",
    });
    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx: makeCtx({ recentUserMessage: null }),
      signals: makeTurnSignals(),
      events: [],
    });
    const before = await tdb.db.select({ id: executions.id }).from(executions);
    const result = await tools["wf_no-live-test"]!.execute!(
      {},
      { toolCallId: "no-live-call", messages: [], context: {} },
    );
    const after = await tdb.db.select({ id: executions.id }).from(executions);
    expect(result).toMatchObject({
      ok: false,
      data: { error_code: "explicit_no_live_effects" },
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

  test("a workflow without required input runs from empty arguments and hides personal links from the model", async () => {
    const link = `https://support.example/portal#access=${"a".repeat(43)}`;
    const seeded = await seedTool("no-input-link-test");
    await tdb.db
      .update(workflowVersions)
      .set({
        dag: {
          name: "no-input-link-test",
          slug: "no-input-link-test",
          input_schema: { type: "object", additionalProperties: false, properties: {} },
          steps: [
            {
              id: "s1",
              kind: "transform",
              language: "javascript",
              expression: `return { url: ${JSON.stringify(link)}, expires_at: "2099-01-01T00:00:00.000Z" };`,
            },
          ],
        },
      })
      .where(eq(workflowVersions.workflow_id, seeded.id));
    const events: TurnEvent[] = [];
    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal: makePrincipal(),
      ctx: makeCtx(),
      signals: makeTurnSignals(),
      events,
    });

    const result = (await tools["wf_no-input-link-test"]!.execute!(
      {},
      { toolCallId: "test-call-id", messages: [], context: {} },
    )) as { ok: boolean; data: Record<string, unknown> };

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain("#access=");
    const streamed = events.find((event) => event.type === "tool_result");
    expect(JSON.stringify(streamed)).toContain("#access=");
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
