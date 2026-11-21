import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  executions,
  scheduleOccurrences,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let workflowId = "";

const DUE = new Date("2026-03-02T08:00:00.000Z");

beforeAll(async () => {
  srv = await createHttpTestServer("schedule-occurrence-outcome");
  const [wf] = await srv.db
    .insert(workflows)
    .values({ tenant_id: srv.tenantId, slug: "wf-occ", name: "Occ", lifecycle: "active" })
    .returning();
  workflowId = wf!.id;
  const [version] = await srv.db
    .insert(workflowVersions)
    .values({ tenant_id: srv.tenantId, workflow_id: workflowId, version: 1, dag: { steps: [] } })
    .returning();
  const runs = await srv.db
    .insert(executions)
    .values(
      (["failed", "succeeded", "timed_out"] as const).map((status, i) => ({
        tenant_id: srv.tenantId,
        workflow_id: workflowId,
        workflow_version_id: version!.id,
        status,
        request_source: "scheduler",
        execution_mode: "prod" as const,
        started_at: new Date(DUE.getTime() + i * 3_600_000),
        finished_at: new Date(DUE.getTime() + i * 3_600_000 + 1_000),
      })),
    )
    .returning({ id: executions.id });
  await srv.db.insert(scheduleOccurrences).values([
    ...runs.map((run, i) => ({
      tenant_id: srv.tenantId,
      workflow_id: workflowId,
      due_at: new Date(DUE.getTime() + i * 3_600_000),
      last_due_at: new Date(DUE.getTime() + i * 3_600_000),
      started_at: new Date(DUE.getTime() + i * 3_600_000),
      state: "ran" as const,
      execution_id: run.id,
    })),
    {
      tenant_id: srv.tenantId,
      workflow_id: workflowId,
      due_at: new Date(DUE.getTime() + 3 * 3_600_000),
      last_due_at: new Date(DUE.getTime() + 3 * 3_600_000),
      state: "skipped" as const,
      reason_code: "calendar_weekend",
      skipped_count: 1,
    },
  ]);
});

afterAll(async () => {
  await srv.cleanup();
});

describe("schedule occurrences carry the outcome of the run they started", () => {
  test("failed and timed-out runs read failed, a finished one succeeded, a skipped one none", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/workflows/${workflowId}/schedule-occurrences`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ state: string; run_outcome: string | null }>;
    };
    expect(body.items.map((item) => [item.state, item.run_outcome])).toEqual([
      ["skipped", null],
      ["ran", "failed"],
      ["ran", "succeeded"],
      ["ran", "failed"],
    ]);
  });
});
