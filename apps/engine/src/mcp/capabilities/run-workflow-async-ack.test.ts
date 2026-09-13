// run_workflow async-ack: execution-handle discovery.
//
// When a `run_workflow` MCP call outlives the inline tools/call deadline
// (TOOLS_CALL_DEADLINE_MS), the response must hand back the running
// execution_id as a poll handle — mirroring the wf_<slug> async-ack — so a
// client polls get_execution instead of retrying and double-executing. The
// poll handle is sourced by `findBackgroundExecutionId`, unit-tested here so
// the discovery logic is verified without waiting out the 30s deadline.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { conversations, executions, workflows } from "../../db/schema/index.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { type McpTestSuite, startMcpTestSuite } from "../tests/setup.ts";
import {
  findBackgroundExecutionId,
  resolveConversationBoundWorkflowId,
} from "./run-workflow-async-ack.ts";

let suite: McpTestSuite;

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
    // Two executions after `since`; the most recent must win.
    await seedRunningExecution(wf.id, new Date(since + 10));
    const newer = await seedRunningExecution(wf.id, new Date(since + 50));

    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      workflowRef: wf.slug,
      since,
    });
    expect(found).toBe(newer);
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
    // A prior run of the same workflow, created before our window opens.
    const start = FROZEN_NOW;
    await seedRunningExecution(wf.id, new Date(start - 60_000));

    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      workflowRef: wf.slug,
      since: start,
    });
    expect(found).toBeNull();
  });

  test("returns null when no workflow reference is supplied", async () => {
    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      workflowRef: undefined,
      since: FROZEN_NOW,
    });
    expect(found).toBeNull();
  });

  test("returns null for an unresolvable workflow reference", async () => {
    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
      workflowRef: "does-not-exist-slug",
      since: FROZEN_NOW,
    });
    expect(found).toBeNull();
  });

  test("resolves a workflow whose published version was rotated out mid-run", async () => {
    // A workflow the tool ran but whose current_version_id is now null (a
    // publish rotate raced the run). The ack MUST still resolve it — a
    // `require_published` filter here would orphan the live run into
    // engine_busy, the exact failure the poll handle prevents.
    const [wf] = await suite.http.db
      .insert(workflows)
      .values({
        tenant_id: suite.http.tenantId,
        slug: "async-ack-unpublished",
        name: "Async Ack Unpublished",
        lifecycle: "active",
        // current_version_id intentionally left null
      })
      .returning();
    if (!wf) throw new Error("seed workflow failed");
    const since = FROZEN_NOW;
    const exec = await seedRunningExecution(wf.id, new Date(since + 10));

    const found = await findBackgroundExecutionId({
      db: suite.http.db,
      tenant_id: suite.http.tenantId,
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
    // Older conversation bound to A, newer bound to B — the newer must win.
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
    // Most-recent is abandoned (must be skipped); an active one with no
    // target (must be skipped); the older active+bound one must win.
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
