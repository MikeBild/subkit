import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resolveWorkflowEffectManifest } from "../effect-resolution.ts";

let ctx: TestDb;
let counter = 0;
beforeAll(async () => {
  ctx = await createTestDb("effect_resolution_calls");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function fixture(
  opts: { childSteps?: unknown[]; parentCall?: Record<string, unknown> } = {},
) {
  const slug = `calls-${++counter}`;
  const [tenant] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant fixture");
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test/api/v1",
    })
    .returning();
  if (!connector) throw new Error("missing connector fixture");
  const make = async (name: string, steps: unknown[], lifecycle: "active" | "archived") => {
    const [workflow] = await ctx.db
      .insert(workflows)
      .values({ tenant_id: tenant.id, slug: `${slug}-${name}`, name, lifecycle })
      .returning();
    if (!workflow) throw new Error("missing workflow fixture");
    const [version] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        version: 1,
        dag: { name, steps },
      })
      .returning();
    if (!version) throw new Error("missing version fixture");
    await ctx.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, workflow.id));
    return { workflow, version };
  };
  const child = await make(
    "child",
    opts.childSteps ?? [
      {
        id: "publish",
        kind: "request",
        method: "POST",
        connector_id: connector.id,
        path: "/api/v1/publish",
        body: { text: "Hello" },
      },
    ],
    "active",
  );
  const parent = await make(
    "parent",
    [
      {
        id: "collect",
        kind: "request",
        method: "POST",
        connector_id: connector.id,
        path: "/api/v1/collect",
        body: { ok: true },
      },
      {
        id: "run_child",
        kind: "call",
        depends_on: ["collect"],
        workflow_id: child.workflow.id,
        ...opts.parentCall,
      },
    ],
    "active",
  );
  return {
    tenant,
    connector,
    child,
    parent,
    input: {
      tenant_id: tenant.id,
      workflow_id: parent.workflow.id,
      workflow_version_id: parent.version.id,
      execution_environment: "dev" as "dev" | "prod",
      execution_options_digest: "a".repeat(64),
    },
  };
}

test("a workflow that starts another one becomes approvable, child effects included", async () => {
  const f = await fixture();
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db, { include_review: true });
  expect(result.manifest.issues).toEqual([]);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects.map((e) => [e.step_id, e.call_path?.[0] ?? null])).toEqual([
    ["collect", null],
    ["publish", "run_child"],
  ]);
  expect(result.manifest.calls).toEqual([
    expect.objectContaining({
      step_id: "run_child",
      workflow_id: f.child.workflow.id,
      workflow_version_id: f.child.version.id,
    }),
  ]);
  expect(result.execution_shape?.calls).toEqual([
    expect.objectContaining({ step_id: "run_child", workflow_name: "child", version: 1 }),
  ]);
  expect(
    result.execution_shape?.requests.map((r) => [r.step_id, r.call_path?.[0] ?? null]),
  ).toEqual([
    ["collect", null],
    ["publish", "run_child"],
  ]);
  expect(await resolveWorkflowEffectManifest(f.input, ctx.db, { include_review: true })).toEqual(
    result,
  );
});

test("activating a new child version moves the parent's digest", async () => {
  const f = await fixture();
  const before = await resolveWorkflowEffectManifest(f.input, ctx.db);
  const [next] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: f.child.workflow.id,
      version: 2,
      dag: {
        name: "child",
        steps: [
          {
            id: "publish",
            kind: "request",
            method: "POST",
            connector_id: f.connector.id,
            path: "/api/v1/publish",
            body: { text: "Different" },
          },
        ],
      },
    })
    .returning();
  await ctx.db
    .update(workflows)
    .set({ current_version_id: next?.id })
    .where(eq(workflows.id, f.child.workflow.id));
  const after = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(after.digest).not.toBe(before.digest);
  expect(after.manifest.calls?.[0]?.workflow_version_id).toBe(next?.id ?? "");
});

test("an archived child leaves the call unbound", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "archived" })
    .where(eq(workflows.id, f.child.workflow.id));
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.manifest.issues).toEqual([{ step_id: "run_child", code: "unbound_workflow_call" }]);
  expect(result.call_refusals).toEqual([{ step_id: "run_child", reason: "child_unavailable" }]);
  expect(result.eligible_for_repeated_runs).toBe(false);
});

test("a child that starts a workflow itself keeps the parent unbound", async () => {
  const f = await fixture({
    childSteps: [
      {
        id: "publish",
        kind: "request",
        method: "POST",
        url: "https://example.test/api/v1/publish",
        body: { text: "Hello" },
      },
      { id: "deeper", kind: "call", workflow_slug: "somewhere" },
    ],
  });
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.call_refusals).toEqual([{ step_id: "run_child", reason: "child_calls_workflow" }]);
  expect(result.eligible_for_repeated_runs).toBe(false);
});

test("a call naming both a workflow and a slug is refused", async () => {
  const f = await fixture({ parentCall: { workflow_slug: "anything" } });
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.call_refusals).toEqual([{ step_id: "run_child", reason: "target_not_static" }]);
});

test("a child's unbindable step blocks the parent, marked as the child's", async () => {
  const f = await fixture({
    childSteps: [
      {
        id: "publish",
        kind: "request",
        method: "POST",
        connector_id: "00000000-0000-4000-8000-0000000000ff",
        path: "/api/v1/publish",
        body: { text: "Hello" },
      },
    ],
  });
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.manifest.issues).toEqual([
    { step_id: "publish", code: "missing_binding", call_path: ["run_child"] },
  ]);
  expect(result.eligible_for_repeated_runs).toBe(false);
});

test("a child never inherits the parent's proposal-derived permissions", async () => {
  const f = await fixture({
    childSteps: [
      {
        id: "send_report",
        kind: "request",
        method: "POST",
        path: "/gmail/v1/users/me/messages/send",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        body: { raw: "${steps.render.data.raw}" },
      },
    ],
  });
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  const childEffects = result.manifest.effects.filter((e) => e.call_path?.[0] === "run_child");
  for (const effect of childEffects) {
    expect(effect.report_delivery).toBeUndefined();
    expect(effect.content_publication).toBeUndefined();
  }
});
