import { expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import {
  conversationElicitations,
  webhooksInbound,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { logger } from "../../../logging/index.ts";
import { workflowExecutionEnvironment } from "../../../workflows/execution-environment.ts";
import { humanChatAnswer } from "../../answer-actor.ts";
import { maybeAutoPersistFromElicitation } from "../../persistence/auto-persist/index.ts";
import { wrapTools } from "../sdk-wrap.ts";
import { buildSyntheticWorkflowTools } from "./synthetic-workflow-tools.ts";
import {
  conversationId,
  makeCtx,
  makePrincipal,
  makeTurnSignals,
  receivedBody,
  requests,
  requestUrl,
  seedTool,
  tdb,
  tenantId,
  useSyntheticWorkflowToolsSetup,
} from "./tests/synthetic-workflow-tools-fixtures.ts";

useSyntheticWorkflowToolsSetup();

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
    const wrapped = await wrapTools(makeCtx(), makeTurnSignals(), [], tdb.db, [], {}, principal);
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
