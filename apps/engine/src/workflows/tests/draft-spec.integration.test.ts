import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import type { WorkflowSpec } from "../draft-schemas.ts";
import { getWorkflowDraft, type SaveWorkflowDraftResult, saveWorkflowDraft } from "../drafts.ts";
import { createWorkflow, updateWorkflow } from "../service.ts";
import { WorkflowDefSchema } from "../types.ts";
import { rotateWorkflowVersionInternal } from "../version-rotate.ts";
import { workflowSpecDigest } from "../version-spec.ts";
import { restoreWorkflowVersion } from "../versions.ts";

let ctx: TestDb;
let tenant_id = "";
let otherTenantId = "";
beforeAll(async () => {
  ctx = await createTestDb("workflow_draft_spec");
  const rows = await ctx.db
    .insert(tenants)
    .values([
      { slug: "spec-owner", display_name: "Spec owner" },
      { slug: "spec-other", display_name: "Other tenant" },
    ])
    .returning();
  const owner = rows.find((row) => row.slug === "spec-owner");
  const other = rows.find((row) => row.slug === "spec-other");
  if (!owner || !other) throw new Error("missing test tenants");
  tenant_id = owner.id;
  otherTenantId = other.id;
});
afterAll(async () => {
  await ctx.cleanup();
});

function definition(slug: string, value = 1) {
  return {
    name: slug,
    slug,
    trigger: { kind: "schedule", cron: "0 8 * * *", tz: "Europe/Berlin" },
    steps: [{ id: "output", kind: "transform", expression: `return ${value};` }],
  };
}

function spec(goal: string): WorkflowSpec {
  return {
    goal,
    inputs: [{ name: "account", description: "The account to report on" }],
    outputs: [{ name: "summary" }],
    delivery: { channel: "email", destination: "ops@example.test" },
    conventions_applied: [{ note: "Amounts in EUR" }],
    evidence: [{ source: "runbook", locator: "section 2" }],
    open_questions: [],
    origin: "person",
  };
}

function unwrap(result: SaveWorkflowDraftResult) {
  if (!result.draft) throw new Error(result.errors.join("; "));
  return result.draft;
}

async function specAudits(workflow_id: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.resource_id, workflow_id),
        eq(auditLog.action, "draft.spec.updated"),
      ),
    );
}

async function versionSpec(version_id: string) {
  const [row] = await ctx.db
    .select({ spec: workflowVersions.spec })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.id, version_id)));
  return row?.spec ?? null;
}

async function setCurrentSpec(workflow_id: string, value: WorkflowSpec) {
  const [wf] = await ctx.db
    .select({ current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)));
  if (!wf?.current_version_id) throw new Error("workflow has no current version");
  await ctx.db
    .update(workflowVersions)
    .set({ spec: value })
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.id, wf.current_version_id),
      ),
    );
}

test("a draft stores its spec and audits the change with the spec digests", async () => {
  const draft = unwrap(
    await saveWorkflowDraft(
      {
        tenant_id,
        def: definition("spec-create"),
        spec: spec("Report open invoices"),
        actor_id: null,
        request_source: "api",
      },
      ctx.db,
    ),
  );
  expect(draft.spec?.goal).toBe("Report open invoices");
  expect((await getWorkflowDraft(tenant_id, draft.workflow_id, ctx.db))?.spec).toEqual(
    spec("Report open invoices"),
  );
  const audits = await specAudits(draft.workflow_id);
  expect(audits).toHaveLength(1);
  expect(audits[0]?.before).toEqual({ version_id: null, spec_digest: null });
  expect(audits[0]?.after).toEqual({
    version_id: draft.version_id,
    spec_digest: workflowSpecDigest(spec("Report open invoices")),
  });
  expect(audits[0]?.metadata).toMatchObject({ origin: "person", request_source: "api" });
});

test("a pure spec edit creates a new inert draft version with the same definition digest", async () => {
  const first = unwrap(
    await saveWorkflowDraft(
      {
        tenant_id,
        def: definition("spec-pure-edit"),
        spec: spec("First goal"),
        actor_id: null,
        request_source: "api",
      },
      ctx.db,
    ),
  );
  const second = unwrap(
    await saveWorkflowDraft(
      {
        tenant_id,
        workflow_id: first.workflow_id,
        expected_draft_version_id: first.version_id,
        def: definition("spec-pure-edit"),
        spec: spec("Second goal"),
        actor_id: null,
        request_source: "api",
      },
      ctx.db,
    ),
  );
  expect(second.version_id).not.toBe(first.version_id);
  expect(second.version).toBe(first.version + 1);
  expect(second.digest).toBe(first.digest);
  expect(second.spec?.goal).toBe("Second goal");
  expect(second.current_version_id).toBeNull();
  const audits = await specAudits(first.workflow_id);
  expect(audits).toHaveLength(2);
  const edit = audits.find(
    (row) => (row.after as { version_id: string }).version_id === second.version_id,
  );
  expect(edit?.before).toEqual({
    version_id: first.version_id,
    spec_digest: workflowSpecDigest(spec("First goal")),
  });
  expect(edit?.after).toEqual({
    version_id: second.version_id,
    spec_digest: workflowSpecDigest(spec("Second goal")),
  });
});

test("the same definition and spec is a no-op and writes no spec audit", async () => {
  const first = unwrap(
    await saveWorkflowDraft(
      {
        tenant_id,
        def: definition("spec-noop"),
        spec: spec("Stable goal"),
        actor_id: null,
        request_source: "api",
      },
      ctx.db,
    ),
  );
  const again = unwrap(
    await saveWorkflowDraft(
      {
        tenant_id,
        workflow_id: first.workflow_id,
        expected_draft_version_id: first.version_id,
        def: definition("spec-noop"),
        spec: spec("Stable goal"),
        actor_id: null,
        request_source: "api",
      },
      ctx.db,
    ),
  );
  expect(again).toEqual(first);
  expect(await specAudits(first.workflow_id)).toHaveLength(1);
});

test("a definition edit without a spec keeps the base version's spec", async () => {
  const first = unwrap(
    await saveWorkflowDraft(
      {
        tenant_id,
        def: definition("spec-carry"),
        spec: spec("Carried goal"),
        actor_id: null,
        request_source: "api",
      },
      ctx.db,
    ),
  );
  const second = unwrap(
    await saveWorkflowDraft(
      {
        tenant_id,
        workflow_id: first.workflow_id,
        expected_draft_version_id: first.version_id,
        def: definition("spec-carry", 2),
        actor_id: null,
        request_source: "api",
      },
      ctx.db,
    ),
  );
  expect(second.version_id).not.toBe(first.version_id);
  expect(second.spec).toEqual(spec("Carried goal"));
  expect(await specAudits(first.workflow_id)).toHaveLength(1);
});

test("a first draft of an active workflow keeps the active version's spec", async () => {
  const created = await createWorkflow(
    { tenant_id, def: definition("spec-active-base"), actor_id: null },
    ctx.db,
  );
  if (!created.workflow) throw new Error(created.errors.join("; "));
  await setCurrentSpec(created.workflow.id, spec("Active goal"));
  const draft = unwrap(
    await saveWorkflowDraft(
      {
        tenant_id,
        workflow_id: created.workflow.id,
        expected_draft_version_id: null,
        def: definition("spec-active-base", 2),
        actor_id: null,
        request_source: "api",
      },
      ctx.db,
    ),
  );
  expect(draft.spec).toEqual(spec("Active goal"));
});

test("an invalid spec is refused before anything is written", async () => {
  const result = await saveWorkflowDraft(
    {
      tenant_id,
      def: definition("spec-invalid"),
      spec: { ...spec("x"), origin: "machine" },
      actor_id: null,
      request_source: "api",
    },
    ctx.db,
  );
  expect(result.code).toBe("invalid_definition");
  expect(result.errors?.[0]).toStartWith("spec.origin");
  const rows = await ctx.db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.slug, "spec-invalid")));
  expect(rows).toHaveLength(0);
});

test("another tenant cannot read a draft's spec", async () => {
  const draft = unwrap(
    await saveWorkflowDraft(
      {
        tenant_id,
        def: definition("spec-isolated"),
        spec: spec("Private goal"),
        actor_id: null,
        request_source: "api",
      },
      ctx.db,
    ),
  );
  expect(await getWorkflowDraft(otherTenantId, draft.workflow_id, ctx.db)).toBeNull();
});

test("updating, rotating and restoring a workflow keep the spec of the version they start from", async () => {
  const created = await createWorkflow(
    { tenant_id, def: definition("spec-versions"), actor_id: null },
    ctx.db,
  );
  if (!created.workflow) throw new Error(created.errors.join("; "));
  const workflow_id = created.workflow.id;
  await setCurrentSpec(workflow_id, spec("Version goal"));

  const updated = await updateWorkflow(
    { tenant_id, id: workflow_id, def: definition("spec-versions", 2), actor_id: null },
    ctx.db,
  );
  if (!updated?.workflow?.current_version_id) throw new Error("update failed");
  expect(await versionSpec(updated.workflow.current_version_id)).toEqual(spec("Version goal"));

  const rotated = await ctx.db.transaction((tx) =>
    rotateWorkflowVersionInternal(
      {
        tenant_id,
        workflow_id,
        def: WorkflowDefSchema.parse(definition("spec-versions", 3)),
        note: "rotation",
      },
      tx,
    ),
  );
  expect(await versionSpec(rotated.version_id)).toEqual(spec("Version goal"));

  await setCurrentSpec(workflow_id, spec("Newer goal"));
  const restored = await restoreWorkflowVersion(tenant_id, workflow_id, 2, null, ctx.db);
  if (!restored?.current_version_id) throw new Error("restore failed");
  expect(await versionSpec(restored.current_version_id)).toEqual(spec("Version goal"));
});
