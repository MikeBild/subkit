import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { executionSteps, executions, workflows, workflowVersions } from "../db/schema/index.ts";
import { readPlaybook, updatePlaybook } from "./playbook.ts";
import {
  call,
  fixture,
  nextSequence,
  plan,
  scope,
  step,
  tenantId,
  timestamp,
  usePlaybookSetup,
} from "./playbook-fixtures.ts";

usePlaybookSetup();

async function seededRun(dag: { steps: Array<{ id: string; kind: string }> }, hold_writes = true) {
  const [workflow] = await fixture.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug: `held-evidence-${nextSequence()}`,
      name: "Held evidence",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("missing workflow");
  const [version] = await fixture.db
    .insert(workflowVersions)
    .values({ tenant_id: tenantId, workflow_id: workflow.id, version: 1, dag })
    .returning();
  if (!version) throw new Error("missing version");
  await fixture.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.id, workflow.id)));
  const [run] = await fixture.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      status: "succeeded",
      request_source: "chat",
      execution_mode: "dev",
      hold_writes,
      started_at: timestamp(100),
      finished_at: timestamp(200),
      created_at: timestamp(100),
    })
    .returning();
  if (!run) throw new Error("missing run");
  const rows = await fixture.db
    .insert(executionSteps)
    .values(
      dag.steps.map((item) => ({
        tenant_id: tenantId,
        execution_id: run.id,
        step_key: item.id,
        kind: item.kind,
        status: "succeeded" as const,
        started_at: timestamp(100),
      })),
    )
    .returning();
  return { workflow, version, run, rows };
}

async function evidencedStatus(run: { id: string; workflow_id: string | null }) {
  const context = await scope();
  const read = await call(context, "get_execution", {
    execution: { id: run.id, status: "succeeded" },
    outcome: { kind: "succeeded" },
  });
  const criterion = {
    kind: "execution_succeeded" as const,
    workflow_id: run.workflow_id as string,
    environment: "dev" as const,
    after: timestamp().toISOString(),
  };
  await updatePlaybook(fixture.db, context, {
    expected_revision: 0,
    plan: plan([step(criterion, [read])], "check"),
  });
  return async () => (await readPlaybook(fixture.db, context))?.completion.status;
}

describe("an execution that ran with held writes as playbook evidence", () => {
  test("it is evidence when no step was held, and stops being evidence once a step is held", async () => {
    const { run, rows } = await seededRun({ steps: [{ id: "read", kind: "request" }] });
    const status = await evidencedStatus(run);
    expect(await status()).toBe("verified");
    const first = rows[0];
    if (!first) throw new Error("missing step");
    await fixture.db
      .update(executionSteps)
      .set({ held: true })
      .where(and(eq(executionSteps.tenant_id, tenantId), eq(executionSteps.id, first.id)));
    expect(await status()).toBe("open");
    await fixture.db
      .update(executionSteps)
      .set({ held: false, request_meta: { driver: "http", extras: { held: true } } })
      .where(and(eq(executionSteps.tenant_id, tenantId), eq(executionSteps.id, first.id)));
    expect(await status()).toBe("open");
  });

  test("a write held in a called workflow, at any depth, is no evidence for the caller", async () => {
    const { workflow, version, run } = await seededRun({
      steps: [{ id: "delegate", kind: "call" }],
    });
    const status = await evidencedStatus(run);
    expect(await status()).toBe("verified");
    const child = async (parent_execution_id: string) => {
      const [row] = await fixture.db
        .insert(executions)
        .values({
          tenant_id: tenantId,
          workflow_id: workflow.id,
          workflow_version_id: version.id,
          parent_execution_id,
          status: "succeeded",
          request_source: "tool-chain",
          execution_mode: "dev",
          hold_writes: true,
          started_at: timestamp(110),
          finished_at: timestamp(190),
          created_at: timestamp(110),
        })
        .returning();
      if (!row) throw new Error("missing child");
      return row;
    };
    const called = await child(run.id);
    const nested = await child(called.id);
    expect(await status()).toBe("verified");
    await fixture.db.insert(executionSteps).values({
      tenant_id: tenantId,
      execution_id: nested.id,
      step_key: "send",
      kind: "request",
      status: "succeeded",
      held: true,
      started_at: timestamp(120),
    });
    expect(await status()).toBe("open");
  });

  test("a run without held writes stays evidence as before", async () => {
    const { run } = await seededRun({ steps: [{ id: "read", kind: "request" }] }, false);
    const status = await evidencedStatus(run);
    expect(await status()).toBe("verified");
  });
});
