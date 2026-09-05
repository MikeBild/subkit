import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  tenants,
  webhooksInbound,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { listWorkflowToolsForTenant } from "../catalog.ts";
import { getWorkflowDraft, type SaveWorkflowDraftResult, saveWorkflowDraft } from "../drafts.ts";
import { createWorkflow, getWorkflow } from "../service.ts";

let ctx: TestDb;
let tenant_id = "";
let otherTenantId = "";
beforeAll(async () => {
  ctx = await createTestDb("workflow_drafts");
  const rows = await ctx.db
    .insert(tenants)
    .values([
      { slug: "draft-owner", display_name: "Draft owner" },
      { slug: "draft-other", display_name: "Other tenant" },
    ])
    .returning();
  const owner = rows.find((row) => row.slug === "draft-owner");
  const other = rows.find((row) => row.slug === "draft-other");
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
function unwrap(result: SaveWorkflowDraftResult) {
  if (!result.draft) throw new Error(result.errors.join("; "));
  return result.draft;
}
function save(def: unknown) {
  return saveWorkflowDraft({ tenant_id, def, actor_id: null, request_source: "api" }, ctx.db);
}

test("saving a scheduled draft persists an immutable version but activates nothing", async () => {
  const draft = unwrap(await save(definition("inert-schedule")));
  const [wf] = await ctx.db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, draft.workflow_id)));
  expect(wf?.lifecycle).toBe("draft");
  expect(wf?.current_version_id).toBeNull();
  expect(wf?.draft_version_id).toBe(draft.version_id);
  expect(await getWorkflowDraft(tenant_id, draft.workflow_id, ctx.db)).toEqual(draft);
  expect(
    await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.tenant_id, tenant_id)),
  ).toHaveLength(0);
  expect(
    await ctx.db.select().from(webhooksInbound).where(eq(webhooksInbound.tenant_id, tenant_id)),
  ).toHaveLength(0);
  const catalog = await listWorkflowToolsForTenant({
    db: ctx.db,
    principal: {
      provider: "test",
      kind: "user",
      id: "00000000-0000-4000-8000-000000000001",
      tenant_id,
      roles: ["admin"],
    },
  });
  expect(catalog.some((tool) => tool.workflow_id === draft.workflow_id)).toBe(false);
  const audit = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, draft.workflow_id)));
  expect(audit).toHaveLength(1);
  expect(audit[0]?.metadata).toMatchObject({ kind: "draft", request_source: "api", version: 1 });
});

test("editing an active workflow keeps its active definition and schedule untouched", async () => {
  const live = await createWorkflow(
    { tenant_id, def: definition("live-draft"), actor_id: null },
    ctx.db,
  );
  if (!live.workflow) throw new Error(live.errors.join("; "));
  const id = live.workflow.id;
  const schedulesBefore = await ctx.db
    .select()
    .from(workflowsSchedules)
    .where(
      and(eq(workflowsSchedules.tenant_id, tenant_id), eq(workflowsSchedules.workflow_id, id)),
    );
  const draft = unwrap(
    await saveWorkflowDraft(
      {
        tenant_id,
        workflow_id: id,
        expected_draft_version_id: null,
        def: { ...definition("live-draft", 2), trigger: { kind: "request" } },
        actor_id: null,
        request_source: "tool-chain",
      },
      ctx.db,
    ),
  );
  expect(draft.current_version_id).toBe(live.workflow.current_version_id);
  expect(draft.version_id).not.toBe(live.workflow.current_version_id);
  const stillLive = await getWorkflow(tenant_id, id, ctx.db);
  expect(stillLive?.definition).toEqual(live.workflow.definition);
  expect(stillLive?.lifecycle).toBe("active");
  expect(
    await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(eq(workflowsSchedules.tenant_id, tenant_id), eq(workflowsSchedules.workflow_id, id)),
      ),
  ).toEqual(schedulesBefore);
});

test("unchanged drafts are idempotent and changed drafts retain previous versions", async () => {
  const def = definition("draft-history");
  const first = unwrap(await save(def));
  const input = {
    tenant_id,
    workflow_id: first.workflow_id,
    expected_draft_version_id: first.version_id,
    actor_id: null,
    request_source: "api" as const,
  };
  expect(
    unwrap(
      await saveWorkflowDraft(
        {
          ...input,
          def: { steps: def.steps, trigger: def.trigger, slug: def.slug, name: def.name },
        },
        ctx.db,
      ),
    ),
  ).toEqual(first);
  const next = unwrap(
    await saveWorkflowDraft({ ...input, def: definition("draft-history", 2) }, ctx.db),
  );
  expect(next.version).toBe(2);
  expect(next.digest).not.toBe(first.digest);
  const versions = await ctx.db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.workflow_id, first.workflow_id),
      ),
    );
  expect(versions).toHaveLength(2);
  expect(versions.find((version) => version.id === first.version_id)?.dag).toEqual(
    first.definition,
  );
});

test("concurrent edits cannot silently replace an unseen draft", async () => {
  const first = unwrap(await save(definition("draft-race")));
  const results = await Promise.all(
    [2, 3].map((value) =>
      saveWorkflowDraft(
        {
          tenant_id,
          workflow_id: first.workflow_id,
          expected_draft_version_id: first.version_id,
          def: definition("draft-race", value),
          actor_id: null,
          request_source: "api",
        },
        ctx.db,
      ),
    ),
  );
  expect(results.filter((result) => result.draft)).toHaveLength(1);
  expect(results.filter((result) => result.code === "draft_conflict")).toHaveLength(1);
});

test("draft access stays tenant scoped and updates require an observed base", async () => {
  const first = unwrap(await save(definition("draft-isolation")));
  expect(await getWorkflowDraft(otherTenantId, first.workflow_id, ctx.db)).toBeNull();
  expect(
    (
      await saveWorkflowDraft(
        {
          tenant_id: otherTenantId,
          workflow_id: first.workflow_id,
          expected_draft_version_id: first.version_id,
          def: definition("draft-isolation", 2),
          actor_id: null,
          request_source: "api",
        },
        ctx.db,
      )
    ).code,
  ).toBe("not_found");
  expect(
    (
      await saveWorkflowDraft(
        {
          tenant_id,
          workflow_id: first.workflow_id,
          def: definition("draft-isolation", 2),
          actor_id: null,
          request_source: "api",
        },
        ctx.db,
      )
    ).code,
  ).toBe("draft_conflict");
  expect((await save(definition("draft-isolation"))).code).toBe("slug_conflict");
});
