import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  conversationMessages,
  conversations,
  conversationToolCalls,
  executionFixtures,
  executions,
} from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { OPENAPI_INFO } from "../../http/openapi.ts";
import { getStaticCapabilities } from "../../llm/core/capabilities.ts";
import { buildFileContentBlocks } from "../../llm/core/file-context.ts";
import { analyzeConversationAttachments } from "../../llm/flows/analyze-conversation-attachments.ts";
import { logRing } from "../../observability/log-ring.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import { collectDiagnosticContext, type DiagnosticContext } from "../diagnostic-context.ts";
import { exportDiagnosticContext } from "../diagnostic-export.ts";
import { executionDataTransfer, prepareGate } from "../tools/sdk-wrap/gate-subjects.ts";
import { loadWorkflowInputFile } from "../tools/workflow-file-input.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let fixture: ConversationTestCtx;
beforeAll(async () => {
  fixture = await createConversationTestCtx("diagnostic_context");
});
afterAll(async () => {
  await fixture?.cleanup();
  logRing.clear();
});

const now = new Date("2026-01-02T12:00:00Z");

test("projects only the authenticated owner's current conversation and scoped logs", async () => {
  const [current, unrelated] = await fixture.testDb.db
    .insert(conversations)
    .values([
      { tenant_id: fixture.tenant_id, owner_id: fixture.user_id, status: "active" },
      { tenant_id: fixture.tenant_id, owner_id: fixture.user_id, status: "active" },
    ])
    .returning();
  if (!current || !unrelated) throw new Error("conversation insert failed");
  await fixture.testDb.db.insert(conversationMessages).values([
    {
      tenant_id: fixture.tenant_id,
      conversation_id: current.id,
      role: "user",
      content: { text: "help-with-draft", password: "hidden-password" },
    },
    {
      tenant_id: fixture.tenant_id,
      conversation_id: current.id,
      role: "system",
      content: { text: "hidden-system-instructions" },
    },
    {
      tenant_id: fixture.tenant_id,
      conversation_id: unrelated.id,
      role: "user",
      content: { text: "hidden-other-conversation" },
    },
  ]);
  for (const [tenant, conversation, msg] of [
    [fixture.tenant_id, current.id, "current-log"],
    [fixture.tenant_id, unrelated.id, "hidden-unrelated-log"],
    ["other-tenant", current.id, "hidden-other-tenant-log"],
  ])
    logRing.record({
      ts: now.getTime(),
      level: "info",
      msg,
      fields: { tenant_id: tenant, conversation_id: conversation },
    });
  const ctx = {
    db: fixture.testDb.db,
    tenant_id: fixture.tenant_id,
    conversation_id: current.id,
    actor_id: fixture.user_id,
    principal: {
      id: fixture.user_id,
      tenant_id: fixture.tenant_id,
      kind: "user",
      provider: "local",
      roles: [],
      scopes: ["workflow:run"],
      session_id: "hidden-session",
    },
    getDraft: () => createEmptyDraftDocument(),
  } satisfies DiagnosticContext;
  const artifacts = await collectDiagnosticContext(ctx, now);
  const encoded = JSON.stringify(artifacts);
  expect(encoded).toContain("help-with-draft");
  expect(encoded).toContain("current-log");
  expect(encoded).toContain("workflow:run");
  expect(encoded).not.toContain("hidden-");
  expect(artifacts.find((artifact) => artifact.name === "configuration")?.status).toBe(
    "unavailable",
  );
  expect(encoded).not.toContain("database.url");
  expect(artifacts.find((artifact) => artifact.name === "logs")?.status).toBe("partial");
  const exported = await exportDiagnosticContext(ctx, now);
  expect(JSON.stringify(exported)).not.toContain("help-with-draft");
  expect(exported.collection_complete).toBe(false);
  const transfer = await loadWorkflowInputFile(ctx, exported.input_file);
  expect(transfer.parts).toBeArray();
  expect(transfer.engine_version).toBe(OPENAPI_INFO.version);
  expect(exported.part_count).toBeGreaterThan(0);
  const modelFiles = await buildFileContentBlocks({
    db: ctx.db,
    tenant_id: ctx.tenant_id,
    capabilities: getStaticCapabilities("openai"),
    fids: [
      exported.input_file.id,
      ...(transfer.parts as Array<{ data: { $file: string } }>).map((part) => part.data.$file),
    ],
  });
  expect(modelFiles.blocks).toEqual([]);
  const transferGate = await prepareGate(
    "run_workflow",
    { workflow: "service-send", input_file: exported.input_file },
    ctx.tenant_id,
    ctx.db,
  );
  expect(transferGate.execution_data_transfer).toBe(true);
  expect(transferGate.pending_output?.execution_data_transfer).toBeDefined();
  const ordinaryGate = await prepareGate(
    "run_workflow",
    { workflow: "service-send", input: { title: "x" } },
    ctx.tenant_id,
    ctx.db,
  );
  expect(ordinaryGate.execution_data_transfer).toBeUndefined();
  const inlineGate = await prepareGate(
    "run_workflow",
    { workflow: "service-send", input: { parts: transfer.parts, manifest: transfer.manifest } },
    ctx.tenant_id,
    ctx.db,
  );
  expect(inlineGate.execution_data_transfer).toBe(true);
  expect(
    await executionDataTransfer(
      { parts: transfer.parts, manifest: transfer.manifest },
      ctx.tenant_id,
      ctx.db,
    ),
  ).not.toBeNull();
  expect(await executionDataTransfer({ title: "x" }, ctx.tenant_id, ctx.db)).toBeNull();

  expect(
    await analyzeConversationAttachments({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
    }),
  ).toBeNull();

  await expect(collectDiagnosticContext({ ...ctx, actor_id: null }, now)).rejects.toThrow(
    "authenticated",
  );
  await expect(
    collectDiagnosticContext(
      {
        ...ctx,
        principal: { ...ctx.principal!, id: "00000000-0000-4000-8000-000000000002" },
        actor_id: "00000000-0000-4000-8000-000000000002",
      },
      now,
    ),
  ).rejects.toThrow("not available");
});

test("includes referenced caller-owned runs and readable resources while excluding other callers and out-of-window runs", async () => {
  const db = fixture.testDb.db;
  const workflow = await createWorkflowRow(
    { testDb: fixture.testDb, tenantId: fixture.tenant_id, cleanup: fixture.cleanup },
    {
      name: "Linked diagnostic workflow",
      slug: "linked-diagnostic-workflow",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          connector_id: fixture.connector_id,
          path: "/users",
        },
      ],
    },
  );
  const [conversation] = await db
    .insert(conversations)
    .values({
      tenant_id: fixture.tenant_id,
      owner_id: fixture.user_id,
      target_workflow_id: workflow.workflow_id,
      status: "active",
    })
    .returning();
  const [retained] = await db
    .insert(executionFixtures)
    .values({
      tenant_id: fixture.tenant_id,
      kind: "offload",
      body: { value: "full-retained-output", token: "hidden-output-token" },
    })
    .returning();
  if (!conversation || !retained) throw new Error("fixture creation failed");
  const caller = {
    tenantId: fixture.tenant_id,
    principalId: fixture.user_id,
    principalKind: "user" as const,
    provider: "local",
    productId: null,
  };
  const runs = await db
    .insert(executions)
    .values(
      [
        {
          input: { value: "owned-input" },
          caller_context: caller,
          created_at: now,
          result_storage_uri: `fixture://${retained.id}`,
        },
        {
          input: { value: "hidden-other-caller" },
          caller_context: { ...caller, principalId: "00000000-0000-4000-8000-000000000002" },
          created_at: now,
        },
        {
          input: { value: "hidden-old-run" },
          caller_context: caller,
          created_at: new Date(now.getTime() - 172_800_000),
        },
        {
          input: { value: "hidden-future-run" },
          caller_context: caller,
          created_at: new Date(now.getTime() + 3_600_000),
        },
      ].map((row) => ({
        ...row,
        tenant_id: fixture.tenant_id,
        workflow_id: workflow.workflow_id,
        workflow_version_id: workflow.version_id,
        status: "succeeded" as const,
        request_source: "api",
        execution_mode: "dev" as const,
      })),
    )
    .returning();
  await db.insert(conversationToolCalls).values(
    runs.map((run) => ({
      tenant_id: fixture.tenant_id,
      conversation_id: conversation.id,
      tool: "run_workflow",
      input: {},
      output: { execution_id: run.id },
    })),
  );
  const context: DiagnosticContext = {
    db,
    tenant_id: fixture.tenant_id,
    conversation_id: conversation.id,
    actor_id: fixture.user_id,
    principal: {
      id: fixture.user_id,
      tenant_id: fixture.tenant_id,
      kind: "user",
      provider: "local",
      roles: [],
    },
    getDraft: createEmptyDraftDocument,
  };
  const artifacts = await collectDiagnosticContext(context, now);
  const encoded = JSON.stringify(artifacts);
  expect(encoded).toContain("owned-input");
  expect(encoded).toContain("full-retained-output");
  expect(encoded).toContain("Linked diagnostic workflow");
  expect(encoded).toContain(fixture.connector_id);
  expect(encoded).not.toContain("hidden-");
  const data = artifacts.find((artifact) => artifact.name === "executions")?.data as {
    runs: unknown[];
  };
  expect(data.runs).toHaveLength(1);
  const restricted = await collectDiagnosticContext(
    {
      ...context,
      principal: { ...context.principal!, scopes: ["workflow:run"] },
    },
    now,
  );
  expect(JSON.stringify(restricted)).not.toContain("owned-input");
  expect(JSON.stringify(restricted)).not.toContain("full-retained-output");
  expect(artifacts.find((artifact) => artifact.name === "configuration")?.status).toBe("partial");
  expect(encoded).not.toContain("database.url");
});
