import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  connectors,
  conversationMessages,
  conversations,
  executions,
  sessions,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createBoss, disposeBoss } from "../queue/boss.ts";
import { registerExecutionRunHandler } from "../queue/handlers/execution-run.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { continueConversationDevLiveTest } from "./live-test-continuation.ts";
import { getConversation } from "./service/get.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./tests/setup.ts";

let ctx: ConversationTestCtx;
let remote: MockServer;
let boss: PgBoss;
let session_id: string;
let sequence = 0;

beforeAll(async () => {
  ctx = await createConversationTestCtx("live_test_continuation");
  remote = await createMockServer((_, response) => jsonResponse(response, 200, { ok: true }));
  const [session] = await ctx.testDb.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      expires_at: sql`clock_timestamp() + interval '1 hour'`,
    })
    .returning();
  if (!session) throw new Error("session");
  session_id = session.id;
  boss = await createBoss({ connectionString: ctx.testDb.url });
  await registerExecutionRunHandler({ boss, db: ctx.testDb.db });
});

afterAll(async () => {
  await remote.close();
  await disposeBoss(boss);
  await ctx.cleanup();
});

async function fixture(
  options: { authority?: boolean; veto?: boolean; stale?: boolean; outbound?: boolean } = {},
) {
  const slug = `live-test-${++sequence}`;
  const [workflow] = await ctx.testDb.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenant_id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("workflow");
  const [connector] = options.outbound
    ? await ctx.testDb.db
        .insert(connectors)
        .values({
          tenant_id: ctx.tenant_id,
          slug: `live-test-connector-${sequence}`,
          display_name: slug,
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: remote.baseUrl,
        })
        .returning()
    : [];
  if (options.outbound && !connector) throw new Error("connector");
  const [version] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        slug,
        steps: connector
          ? [
              {
                id: "write",
                kind: "request",
                method: "POST",
                connector_id: connector.id,
                path: "/writes",
                body: { sample: true },
              },
            ]
          : [
              {
                id: "shape",
                kind: "transform",
                language: "javascript",
                expression: "return { ok: true };",
              },
            ],
      },
    })
    .returning();
  if (!version) throw new Error("version");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  if (options.stale)
    await ctx.testDb.db
      .update(workflows)
      .set({ current_version_id: null })
      .where(eq(workflows.id, workflow.id));
  if (options.authority) {
    const now = await databaseNow(ctx.testDb.db);
    const preview = await previewWorkflowAuthority(
      {
        tenant_id: ctx.tenant_id,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        execution_environment: "dev",
      },
      ctx.testDb.db,
    );
    await ctx.testDb.db.insert(workflowExecutionAuthorities).values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      effect_manifest_digest: preview.digest,
      effect_manifest: preview.manifest,
      execution_environment: "dev",
      target_constraints: { targets: [] },
      valid_from: new Date(now.getTime() - 60_000),
      valid_until: new Date(now.getTime() + 60_000),
      max_runs: 5,
      created_by: ctx.user_id,
      approved_manifest: preview.manifest,
    });
  }
  const input = { sample: true };
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenant_id,
      owner_id: ctx.user_id,
      target_workflow_id: workflow.id,
      status: "active",
      draft: {
        workflow: { name: slug, steps: [] },
        session: {
          live_test: {
            workflow_id: workflow.id,
            workflow_version_id: version.id,
            environment: "dev",
            input,
            input_digest: workflowJsonDigest(input),
            idempotency_key: `live:${workflow.id}`,
            state: "pending",
          },
        },
      },
    })
    .returning();
  if (!conversation) throw new Error("conversation");
  if (options.veto)
    await ctx.testDb.db.insert(conversationMessages).values({
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      role: "user",
      content: "Nicht live ausführen",
    });
  return { workflow, version, conversation };
}

function principal() {
  return {
    provider: "test",
    kind: "user" as const,
    id: ctx.user_id,
    tenant_id: ctx.tenant_id,
    roles: ["admin"],
    auth_source: { kind: "browser_session" as const, session_id },
  };
}

test("runs an authorized dev intent exactly once under concurrent resumes", async () => {
  const beforeCalls = remote.callCount();
  const f = await fixture({ authority: true, outbound: true });
  const input = {
    db: ctx.testDb.db,
    principal: principal(),
    boss,
    conversation_id: f.conversation.id,
    workflow_id: f.workflow.id,
    workflow_version_id: f.version.id,
  };
  const [a, b] = await Promise.all([
    continueConversationDevLiveTest(input),
    continueConversationDevLiveTest(input),
  ]);
  expect([a.state, b.state]).toContain("queued");
  const execution = await waitFor(
    async () => {
      const [row] = await ctx.testDb.db
        .select()
        .from(executions)
        .where(
          and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, f.workflow.id)),
        );
      return row?.status === "succeeded" ? row : null;
    },
    { tries: 150, sleepMs: 200, label: "live test queue completion" },
  );
  const rows = await ctx.testDb.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, f.workflow.id)));
  expect(rows).toHaveLength(1);
  expect(remote.callCount() - beforeCalls).toBe(1);
  const reloaded = await getConversation(ctx.tenant_id, f.conversation.id, ctx.testDb.db);
  expect(reloaded?.resume_summary?.live_test).toEqual({
    execution_id: execution.id,
    status: "succeeded",
  });
});

test("does not dispatch without authority, after a veto, or for a stale version", async () => {
  for (const options of [{}, { authority: true, veto: true }, { authority: true, stale: true }]) {
    const f = await fixture(options);
    const result = await continueConversationDevLiveTest({
      db: ctx.testDb.db,
      principal: principal(),
      boss,
      conversation_id: f.conversation.id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
    });
    expect(result.state).toBe("blocked");
    const rows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(
        and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, f.workflow.id)),
      );
    expect(rows).toHaveLength(0);
  }
});

test("refuses a tampered input digest and a different conversation owner", async () => {
  const f = await fixture({ authority: true });
  await ctx.testDb.db
    .update(conversations)
    .set({
      draft: {
        workflow: { name: f.workflow.slug, steps: [] },
        session: {
          live_test: {
            workflow_id: f.workflow.id,
            workflow_version_id: f.version.id,
            environment: "dev",
            input: { changed: true },
            input_digest: workflowJsonDigest({ sample: true }),
            idempotency_key: `live:${f.workflow.id}`,
            state: "pending",
          },
        },
      },
    })
    .where(eq(conversations.id, f.conversation.id));
  const tampered = await continueConversationDevLiveTest({
    db: ctx.testDb.db,
    principal: principal(),
    boss,
    conversation_id: f.conversation.id,
    workflow_id: f.workflow.id,
    workflow_version_id: f.version.id,
  });
  expect(tampered.state).toBe("not_requested");
  await ctx.testDb.db
    .update(conversations)
    .set({ owner_id: "00000000-0000-4000-8000-000000000099" })
    .where(eq(conversations.id, f.conversation.id));
  const owner = await continueConversationDevLiveTest({
    db: ctx.testDb.db,
    principal: { ...principal(), roles: [] },
    boss,
    conversation_id: f.conversation.id,
    workflow_id: f.workflow.id,
    workflow_version_id: f.version.id,
  });
  expect(owner.state).toBe("blocked");
  const rows = await ctx.testDb.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, f.workflow.id)));
  expect(rows).toHaveLength(0);
});

test("retries a queued admission after enqueue failure and dispatches once", async () => {
  const beforeCalls = remote.callCount();
  const f = await fixture({ authority: true, outbound: true });
  const input = {
    db: ctx.testDb.db,
    principal: principal(),
    conversation_id: f.conversation.id,
    workflow_id: f.workflow.id,
    workflow_version_id: f.version.id,
  };
  const unavailable = {
    send: async () => {
      throw new Error("queue unavailable");
    },
  } as unknown as PgBoss;
  const failedEnqueue = await continueConversationDevLiveTest({ ...input, boss: unavailable });
  expect(failedEnqueue.state).toBe("blocked");
  expect(failedEnqueue.execution_id).toBeDefined();
  const executionId = failedEnqueue.execution_id;
  if (!executionId) throw new Error("execution");
  const replay = await continueConversationDevLiveTest({ ...input, boss });
  expect(replay).toMatchObject({ state: "queued", execution_id: executionId });
  await waitFor(
    async () => {
      const [row] = await ctx.testDb.db
        .select()
        .from(executions)
        .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.id, executionId)));
      return row?.status === "succeeded" ? row : null;
    },
    { tries: 150, sleepMs: 200, label: "retried live test queue completion" },
  );
  expect(remote.callCount() - beforeCalls).toBe(1);
});
