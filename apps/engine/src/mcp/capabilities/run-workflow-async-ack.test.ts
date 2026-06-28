// run_workflow async-ack: execution-handle discovery.
//
// When a `run_workflow` MCP call outlives the inline tools/call deadline
// (TOOLS_CALL_DEADLINE_MS), the response must hand back the running
// execution_id as a poll handle — mirroring the wf_<slug> async-ack — so a
// client polls get_execution instead of retrying and double-executing. The
// poll handle is sourced by `findBackgroundExecutionId`, unit-tested here so
// the discovery logic is verified without waiting out the 30s deadline.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executions } from "../../db/schema/index.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { type McpTestSuite, startMcpTestSuite } from "../tests/setup.ts";
import { findBackgroundExecutionId } from "./run-workflow-async-ack.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("run-workflow-async-ack");
});

afterAll(async () => {
  await suite.cleanup();
});

async function seedRunningExecution(workflowId: string, createdAt: Date): Promise<string> {
  const [row] = await suite.http.db
    .insert(executions)
    .values({
      tenant_id: suite.http.tenantId,
      workflow_id: workflowId,
      source_kind: "saved",
      status: "running",
      request_source: "chat",
      execution_mode: "dev",
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
});
