import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executions, toolApprovals } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import {
  seedConnector,
  seedConversation,
  seedTenant,
  seedWorkflow,
} from "../../test-helpers/seed.ts";
import { tryFastPath } from "../fast-path.ts";
import type { FastPathParams } from "./types.ts";

let tdb: TestDb;
let tenantId: string;
let remote: MockServer;

function principal(): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: "00000000-0000-4000-8000-0000000000fc",
    tenant_id: tenantId,
    roles: ["admin"],
  };
}

async function params(user_message: string): Promise<FastPathParams> {
  const conversation = await seedConversation(tdb.db, { tenant_id: tenantId });
  return {
    db: tdb.db,
    tenant_id: tenantId,
    conversation_id: conversation.id,
    actor_id: null,
    principal: principal(),
    user_message,
    answer_actor: TEST_HUMAN_ANSWER,
  };
}

function readStep(id: string, connector_id: string) {
  return { id, kind: "request", connector_id, method: "GET", path: "/items" };
}

async function executionCount(workflow_id: string): Promise<number> {
  const rows = await tdb.db
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.tenant_id, tenantId), eq(executions.workflow_id, workflow_id)));
  return rows.length;
}

beforeAll(async () => {
  tdb = await createTestDb("conversations-fast-path-run-environment");
  remote = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));
  tenantId = (await seedTenant(tdb.db)).id;
});

afterAll(async () => {
  await remote.close();
  await tdb.cleanup();
});

beforeEach(() => {
  resetMockProvider();
});

describe("fast path run without trigger or clear binding", () => {
  test("connectors that do not all bind in dev hand the turn to the model", async () => {
    const devOnly = await seedConnector(tdb.db, {
      tenant_id: tenantId,
      slug: "split-dev-only",
      environment: "dev",
      base_url: remote.baseUrl,
    });
    const prodOnly = await seedConnector(tdb.db, {
      tenant_id: tenantId,
      slug: "split-prod-only",
      environment: "prod",
      base_url: remote.baseUrl,
    });
    const { workflow } = await seedWorkflow(tdb.db, {
      tenant_id: tenantId,
      dag: {
        name: "split-bindings",
        slug: "split-bindings",
        steps: [readStep("a", devOnly.id), readStep("b", prodOnly.id)],
      },
    });
    const before = remote.callCount();

    const hit = await tryFastPath(await params("run split-bindings"));

    expect(hit).toBeNull();
    expect(getMockProvider().calls.length).toBe(0);
    expect(remote.callCount() - before).toBe(0);
    expect(await executionCount(workflow.id)).toBe(0);
    const pending = await tdb.db
      .select({ id: toolApprovals.id })
      .from(toolApprovals)
      .where(eq(toolApprovals.tenant_id, tenantId));
    expect(pending).toHaveLength(0);
  });

  test("connectors that bind in dev and prod still run in dev", async () => {
    const dev = await seedConnector(tdb.db, {
      tenant_id: tenantId,
      slug: "both-envs",
      environment: "dev",
      base_url: remote.baseUrl,
    });
    await seedConnector(tdb.db, {
      tenant_id: tenantId,
      slug: "both-envs",
      environment: "prod",
      base_url: remote.baseUrl,
    });
    const { workflow } = await seedWorkflow(tdb.db, {
      tenant_id: tenantId,
      dag: { name: "both-bindings", slug: "both-bindings", steps: [readStep("a", dev.id)] },
    });

    const hit = await tryFastPath(await params("run both-bindings"));

    expect(hit?.fast_path_tool).toBe("run_workflow");
    expect(getMockProvider().calls.length).toBe(0);
    const rows = await tdb.db
      .select({ environment: executions.execution_mode, status: executions.status })
      .from(executions)
      .where(and(eq(executions.tenant_id, tenantId), eq(executions.workflow_id, workflow.id)));
    expect(rows).toEqual([{ environment: "dev", status: "succeeded" }]);
  });
});
