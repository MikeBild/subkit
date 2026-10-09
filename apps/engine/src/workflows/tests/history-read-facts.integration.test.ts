import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  connectors,
  executionSteps,
  executions,
  tenants,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { contradictedStorageBoundaries } from "../boundary-evidence.ts";
import { previewWorkflowAuthority } from "../execution-authorities.ts";
import { loadWorkflowHistoryFacts } from "../history-read-facts.ts";
import { loadWorkflowReadFacts } from "../read-facts.ts";
import { inspectHeldPreviewEvidence } from "../report-delivery-proposal.ts";

let ctx: TestDb;
let serial = 0;
beforeAll(async () => {
  ctx = await createTestDb("history_read_facts");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function fixture() {
  const name = `history-${++serial}`;
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: name, display_name: name })
    .returning();
  if (!tenant) throw new Error("missing history tenant");
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenant.id, slug: name, name, lifecycle: "draft" })
    .returning();
  if (!workflow) throw new Error("missing history workflow");
  const versions = await ctx.db
    .insert(workflowVersions)
    .values(
      [1, 2].map((version) => ({
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        version,
        dag: { name, steps: [{ id: "write", kind: "transform", expression: "return {};" }] },
      })),
    )
    .returning();
  const first = versions.find((row) => row.version === 1);
  const second = versions.find((row) => row.version === 2);
  if (!first || !second) throw new Error("missing history versions");
  return { tenant, workflow, first, second };
}

test("batched storage history preserves timestamp and the requested step subset before its limit", async () => {
  const f = await fixture();
  const rows = await ctx.db
    .insert(executions)
    .values(
      Array.from({ length: 502 }, (_, index) => ({
        tenant_id: f.tenant.id,
        workflow_id: f.workflow.id,
        workflow_version_id: f.first.id,
        status: "succeeded" as const,
        source_kind: "saved",
        request_source: "api",
        execution_mode: "dev" as const,
        created_at: new Date(FROZEN_NOW + index * 1000),
      })),
    )
    .returning();
  await ctx.db.insert(executionSteps).values(
    rows.map((run) => ({
      tenant_id: f.tenant.id,
      execution_id: run.id,
      step_key: run.created_at.getTime() === FROZEN_NOW ? "rare" : "busy",
      step_index: 0,
      kind: "request" as const,
      status: "succeeded" as const,
      request_meta: {
        key: run.created_at.getTime() === FROZEN_NOW ? "outside/old.json" : "allowed/new.json",
      },
    })),
  );
  const facts = await loadWorkflowHistoryFacts(
    ctx.db,
    f.tenant.id,
    [f.workflow.id],
    new Map([[f.workflow.id, ["rare", "busy"]]]),
    new Set([f.first.id, f.second.id]),
  );
  const input = {
    tenant_id: f.tenant.id,
    workflow_id: f.workflow.id,
    declared: [{ step_id: "rare", key_prefix: "allowed/" }],
  };
  const single = await contradictedStorageBoundaries(ctx.db, input);
  const batched = await contradictedStorageBoundaries(ctx.db, input, facts);
  expect(single).toEqual([
    {
      step_id: "rare",
      declared_prefix: "allowed/",
      observed_key: "outside/old.json",
      observed_at: new Date(FROZEN_NOW).toISOString(),
    },
  ]);
  expect(batched).toEqual(single);
  const both = {
    ...input,
    declared: [...input.declared, { step_id: "busy", key_prefix: "allowed/" }],
  };
  expect(await contradictedStorageBoundaries(ctx.db, both)).toEqual([]);
  expect(await contradictedStorageBoundaries(ctx.db, both, facts)).toEqual([]);
});

test("batched held evidence selects the latest run separately for each version and environment", async () => {
  const f = await fixture();
  const cases = [
    { version: f.first, environment: "dev" as const },
    { version: f.first, environment: "prod" as const },
    { version: f.second, environment: "dev" as const },
    { version: f.second, environment: "prod" as const },
  ];
  const expected = new Map<string, string>();
  for (const [index, entry] of cases.entries()) {
    const runs = await ctx.db
      .insert(executions)
      .values(
        [false, true].map((latest) => ({
          tenant_id: f.tenant.id,
          workflow_id: f.workflow.id,
          workflow_version_id: entry.version.id,
          status: latest ? ("failed" as const) : ("succeeded" as const),
          source_kind: "saved",
          request_source: "api",
          execution_mode: entry.environment,
          hold_writes: true,
          created_at: new Date(FROZEN_NOW + index * 10000 + (latest ? 1000 : 0)),
        })),
      )
      .returning();
    const latest = runs.find((row) => row.status === "failed");
    if (!latest) throw new Error("missing latest held run");
    expected.set(`${entry.version.id}/${entry.environment}`, latest.id);
    await ctx.db.insert(executionSteps).values(
      runs.map((run) => ({
        tenant_id: f.tenant.id,
        execution_id: run.id,
        step_key: "write",
        step_index: 0,
        kind: "request" as const,
        status: "succeeded" as const,
        request_meta: { extras: { held: true } },
      })),
    );
  }
  const facts = await loadWorkflowHistoryFacts(
    ctx.db,
    f.tenant.id,
    [f.workflow.id],
    new Map([[f.workflow.id, ["write"]]]),
    new Set([f.first.id, f.second.id]),
  );
  for (const entry of cases) {
    const input = {
      tenant_id: f.tenant.id,
      workflow_id: f.workflow.id,
      workflow_version_id: entry.version.id,
      execution_environment: entry.environment,
    };
    const single = await inspectHeldPreviewEvidence(input, ctx.db);
    const expectedExecutionId = expected.get(`${entry.version.id}/${entry.environment}`);
    if (!expectedExecutionId) throw new Error("missing expected held execution");
    expect(single).toEqual({
      execution_id: expectedExecutionId,
      status: "failed",
      steps: [
        { step_id: "write", status: "succeeded", held: true, report_boundary_observed: false },
      ],
    });
    expect(await inspectHeldPreviewEvidence(input, ctx.db, facts)).toEqual(single);
  }
});

test("fact-backed previews preserve explicit empty report and content boundaries and reject foreign scope", async () => {
  const f = await fixture();
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: f.tenant.id,
      slug: "content",
      display_name: "Content",
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url: "https://content.example.test",
    })
    .returning();
  if (!connector) throw new Error("missing content connector");
  const itemId = "00000000-0000-4000-8000-000000000123";
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "Publication",
        steps: [
          {
            id: "report",
            kind: "request",
            method: "POST",
            url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            body: { raw: "encoded report" },
          },
          {
            id: "content",
            kind: "request",
            method: "PUT",
            connector_id: connector.id,
            path: `/v1/content/${itemId}/revisions`,
            headers: { "Content-Type": "text/markdown" },
            body: "# Reviewed report",
          },
        ],
      },
    })
    .where(and(eq(workflowVersions.tenant_id, f.tenant.id), eq(workflowVersions.id, f.first.id)));
  await ctx.db
    .update(workflows)
    .set({ current_version_id: f.first.id, lifecycle: "active" })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
  const [run] = await ctx.db
    .insert(executions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.first.id,
      status: "succeeded",
      source_kind: "saved",
      request_source: "api",
      execution_mode: "dev",
      hold_writes: true,
    })
    .returning();
  if (!run) throw new Error("missing publication preview");
  const reportBoundary = {
    kind: "gmail_report",
    to: "reader@example.test",
    from: "author@example.test",
    content_type: "text/html",
  } as const;
  await ctx.db.insert(executionSteps).values([
    {
      tenant_id: f.tenant.id,
      execution_id: run.id,
      step_key: "report",
      step_index: 0,
      kind: "request",
      status: "succeeded",
      request_meta: {
        extras: {
          held: true,
          report_delivery_proposal: reportBoundary,
        },
      },
    },
    {
      tenant_id: f.tenant.id,
      execution_id: run.id,
      step_key: "content",
      step_index: 1,
      kind: "request",
      status: "succeeded",
      request_meta: {
        extras: {
          held: true,
          content_revision_proposal: {
            origin: "https://content.example.test",
            item_id: itemId,
            bytes: 17,
          },
        },
      },
    },
  ]);
  const input = {
    tenant_id: f.tenant.id,
    workflow_id: f.workflow.id,
    workflow_version_id: f.first.id,
    execution_environment: "dev" as const,
  };
  const facts = await loadWorkflowReadFacts(ctx.db, f.tenant.id, [f.workflow.id], []);
  const single = await previewWorkflowAuthority(input, ctx.db);
  const batch = await previewWorkflowAuthority(input, ctx.db, { facts });
  expect(batch).toEqual(single);
  expect(
    single.manifest.effects.find((effect) => effect.step_id === "report")?.report_delivery,
  ).toEqual(reportBoundary);
  expect(
    single.manifest.effects.find((effect) => effect.step_id === "content")?.content_publication,
  ).toEqual({
    kind: "content_revision",
    origin: "https://content.example.test",
    item_ids: [itemId],
    max_bytes: 1_000_000,
  });
  const empty = { report_boundaries: {}, content_boundaries: {} };
  const explicitSingle = await previewWorkflowAuthority(input, ctx.db, empty);
  const explicitBatch = await previewWorkflowAuthority(input, ctx.db, { ...empty, facts });
  expect(explicitBatch).toEqual(explicitSingle);
  expect(
    explicitSingle.manifest.effects.every(
      (effect) => !effect.report_delivery && !effect.content_publication,
    ),
  ).toBe(true);
  expect(explicitSingle.digest).not.toBe(single.digest);
  const other = await fixture();
  await expect(
    previewWorkflowAuthority({ ...input, tenant_id: other.tenant.id }, ctx.db),
  ).rejects.toThrow("workflow version unavailable");
  await expect(
    previewWorkflowAuthority({ ...input, tenant_id: other.tenant.id }, ctx.db, { facts }),
  ).rejects.toThrow("workflow facts tenant mismatch");
  await expect(
    previewWorkflowAuthority({ ...input, workflow_id: other.workflow.id }, ctx.db),
  ).rejects.toThrow("workflow version unavailable");
  await expect(
    previewWorkflowAuthority({ ...input, workflow_id: other.workflow.id }, ctx.db, { facts }),
  ).rejects.toThrow("workflow version unavailable");
});
