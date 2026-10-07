import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations, executions, workflows } from "../../db/schema/index.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { type McpTestSuite, startMcpTestSuite } from "../tests/setup.ts";
import {
  findBackgroundExecutionId,
  resolveConversationBoundWorkflowId,
} from "./run-workflow-async-ack.ts";

let suite: McpTestSuite;

function principal() {
  return {
    provider: "test",
    kind: "user" as const,
    id: suite.http.userId,
    tenant_id: suite.http.tenantId,
    roles: ["admin"],
  };
}

beforeAll(async () => {
  suite = await startMcpTestSuite("run-workflow-async-ack");
});

afterAll(async () => {
  await suite.cleanup();
});

async function seedRunningExecution(
  workflowId: string,
  createdAt: Date,
  parentExecutionId: string | null = null,
): Promise<string> {
  const [row] = await suite.http.db
    .insert(executions)
    .values({
      tenant_id: suite.http.tenantId,
      workflow_id: workflowId,
      source_kind: "saved",
      status: "running",
      request_source: "chat",
      execution_mode: "dev",
      parent_execution_id: parentExecutionId,
      created_at: createdAt,
    })
    .returning();
  if (!row) throw new Error("seed execution failed");
  return row.id;
}

describe("findBackgroundExecutionId", () => {
  test("returns the most recent execution created at/after the call started", async () => {
    const wf = await suite.seedWorkflow({
      slug: "async-ack-wf",
      name: "Async Ack WF",
      steps: [],
    });
    const since = FROZEN_NOW;
    await seedRunningExecution(wf.id, new Date(since + 10));
    const newer = await seedRunningExecution(wf.id, new Date(since + 50));

    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      principal: principal(),
      workflowRef: wf.slug,
      since,
    });
    expect(found).toBe(newer);
  });

  test("a product caller never receives another owner's background handle", async () => {
    const wf = await suite.seedWorkflow({
      slug: "async-ack-product-owner",
      name: "Async Ack Product Owner",
      steps: [],
    });
    const caller = {
      tenantId: suite.http.tenantId,
      principalId: suite.http.userId,
      principalKind: "user" as const,
      provider: "test",
      productId: "harmoniqs",
    };
    const owned = await suite.http.db
      .insert(executions)
      .values({
        tenant_id: suite.http.tenantId,
        workflow_id: wf.id,
        source_kind: "saved",
        status: "running",
        request_source: "chat",
        execution_mode: "dev",
        caller_context: caller,
        created_at: new Date(FROZEN_NOW + 10),
      })
      .returning({ id: executions.id });
    if (!owned[0]) throw new Error("owned execution missing");
    await suite.http.db.insert(executions).values({
      tenant_id: suite.http.tenantId,
      workflow_id: wf.id,
      source_kind: "saved",
      status: "running",
      request_source: "chat",
      execution_mode: "dev",
      caller_context: { ...caller, principalId: "00000000-0000-4000-8000-000000000091" },
      created_at: new Date(FROZEN_NOW + 20),
    });
    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      principal: { ...principal(), product_id: "harmoniqs" },
      workflowRef: wf.slug,
      since: FROZEN_NOW,
    });
    expect(found).toBe(owned[0].id);
  });

  test("does not return a newer child execution of the same workflow", async () => {
    const wf = await suite.seedWorkflow({
      slug: "async-ack-concurrent-child",
      name: "Async Ack Concurrent Child",
      steps: [],
    });
    const since = FROZEN_NOW;
    const topLevel = await seedRunningExecution(wf.id, new Date(since + 10));
    await seedRunningExecution(wf.id, new Date(since + 50), topLevel);

    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      principal: principal(),
      workflowRef: wf.slug,
      since,
    });
    expect(found).toBe(topLevel);
  });

  test("resolves a UUID workflow reference as well as a slug", async () => {
    const wf = await suite.seedWorkflow({
      slug: "async-ack-uuid",
      name: "Async Ack UUID",
      steps: [],
    });
    const since = FROZEN_NOW;
    const exec = await seedRunningExecution(wf.id, new Date(since + 10));

    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      principal: principal(),
      workflowRef: wf.id,
      since,
    });
    expect(found).toBe(exec);
  });

  test("ignores executions created BEFORE the call started (no stale handle)", async () => {
    const wf = await suite.seedWorkflow({
      slug: "async-ack-stale",
      name: "Async Ack Stale",
      steps: [],
    });
    const start = FROZEN_NOW;
    await seedRunningExecution(wf.id, new Date(start - 60_000));

    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      principal: principal(),
      workflowRef: wf.slug,
      since: start,
    });
    expect(found).toBeNull();
  });

  test("returns null when no workflow reference is supplied", async () => {
    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      principal: principal(),
      workflowRef: undefined,
      since: FROZEN_NOW,
    });
    expect(found).toBeNull();
  });

  test("returns null for an unresolvable workflow reference", async () => {
    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      principal: principal(),
      workflowRef: "does-not-exist-slug",
      since: FROZEN_NOW,
    });
    expect(found).toBeNull();
  });

  test("resolves a workflow whose published version was rotated out mid-run", async () => {
    const [wf] = await suite.http.db
      .insert(workflows)
      .values({
        tenant_id: suite.http.tenantId,
        slug: "async-ack-unpublished",
        name: "Async Ack Unpublished",
        lifecycle: "active",
      })
      .returning();
    if (!wf) throw new Error("seed workflow failed");
    const since = FROZEN_NOW;
    const exec = await seedRunningExecution(wf.id, new Date(since + 10));

    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      principal: principal(),
      workflowRef: wf.slug,
      since,
    });
    expect(found).toBe(exec);
  });
});

describe("resolveConversationBoundWorkflowId", () => {
  test("returns the bound target of the caller's most-recent non-abandoned conversation", async () => {
    const wfA = await suite.seedWorkflow({
      slug: "bound-a",
      name: "Bound A",
      steps: [],
    });
    const wfB = await suite.seedWorkflow({
      slug: "bound-b",
      name: "Bound B",
      steps: [],
    });
    await suite.http.db.insert(conversations).values({
      tenant_id: suite.http.tenantId,
      owner_id: suite.http.userId,
      status: "active",
      target_workflow_id: wfA.id,
      updated_at: new Date(FROZEN_NOW),
    });
    await suite.http.db.insert(conversations).values({
      tenant_id: suite.http.tenantId,
      owner_id: suite.http.userId,
      status: "awaiting_input",
      target_workflow_id: wfB.id,
      updated_at: new Date(FROZEN_NOW + 10_000),
    });

    const bound = await resolveConversationBoundWorkflowId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      owner_id: suite.http.userId,
    });
    expect(bound).toBe(wfB.id);
  });

  test("ignores abandoned conversations and rows with no bound target", async () => {
    const owner = "00000000-0000-4000-8000-000000000182";
    const wf = await suite.seedWorkflow({
      slug: "bound-c",
      name: "Bound C",
      steps: [],
    });
    await suite.http.db.insert(conversations).values({
      tenant_id: suite.http.tenantId,
      owner_id: owner,
      status: "active",
      target_workflow_id: wf.id,
      updated_at: new Date(FROZEN_NOW),
    });
    await suite.http.db.insert(conversations).values({
      tenant_id: suite.http.tenantId,
      owner_id: owner,
      status: "active",
      target_workflow_id: null,
      updated_at: new Date(FROZEN_NOW + 5_000),
    });
    await suite.http.db.insert(conversations).values({
      tenant_id: suite.http.tenantId,
      owner_id: owner,
      status: "abandoned",
      target_workflow_id: wf.id,
      updated_at: new Date(FROZEN_NOW + 10_000),
    });

    const bound = await resolveConversationBoundWorkflowId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      owner_id: owner,
    });
    expect(bound).toBe(wf.id);
  });

  test("returns null when the caller has no bound conversation", async () => {
    const bound = await resolveConversationBoundWorkflowId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      owner_id: "00000000-0000-4000-8000-000000000220",
    });
    expect(bound).toBeNull();
  });
});
