import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  connectors,
  tenants,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { workflowJsonDigest } from "../canonical-json.ts";
import { saveWorkflowDraft } from "../drafts.ts";
import {
  createWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  updateWorkflowMetadata,
} from "../service.ts";
import { listWorkflowVersions, restoreWorkflowVersion } from "../versions.ts";

let ctx: TestDb;
let tenant_id: string;
const user = "10000000-0000-4000-8000-000000000001";
const account = "10000000-0000-4000-8000-000000000002";

beforeAll(async () => {
  ctx = await createTestDb("version_author");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "version-author", display_name: "Author" })
    .returning();
  if (!tenant) throw new Error("test tenant missing");
  tenant_id = tenant.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function definition(variant: string) {
  return {
    name: "Authored workflow",
    slug: "authored-workflow",
    trigger: { kind: "request" },
    steps: [
      { id: "fetch", kind: "request", method: "GET", url: `https://example.test/${variant}` },
    ],
  };
}

function scheduledDefinition(variant: string) {
  return {
    ...definition(variant),
    trigger: { kind: "schedule" as const, cron: "0 9 * * *", tz: "UTC" },
  };
}

test("version writes retain typed authors and restore records its current actor", async () => {
  const created = await createWorkflow(
    { tenant_id, actor_id: user, actor_type: "user", def: definition("initial") },
    ctx.db,
  );
  if (!created.workflow) throw new Error(created.errors.join("; "));
  const id = created.workflow.id;
  const updated = await updateWorkflow(
    {
      tenant_id,
      id,
      actor_id: account,
      actor_type: "system_account",
      def: scheduledDefinition("updated"),
    },
    ctx.db,
  );
  if (!updated.workflow) throw new Error(updated.errors.join("; "));
  const [schedule] = await ctx.db
    .select({ id: workflowsSchedules.id })
    .from(workflowsSchedules)
    .where(eq(workflowsSchedules.workflow_id, id))
    .limit(1);
  if (!schedule) throw new Error("schedule trigger missing");
  const draft = await saveWorkflowDraft(
    {
      tenant_id,
      workflow_id: id,
      expected_draft_version_id: null,
      actor_id: user,
      actor_type: "user",
      request_source: "api",
      def: definition("draft"),
    },
    ctx.db,
  );
  if (!draft.draft) throw new Error(draft.errors.join("; "));
  expect(
    await restoreWorkflowVersion(tenant_id, id, 1, account, ctx.db, "system_account"),
  ).not.toBeNull();
  const unbound = await ctx.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.action, "schedule.trigger.unbound"),
        eq(auditLog.resource_id, schedule.id),
      ),
    )
    .limit(1);
  expect(unbound).toEqual([{ actor_type: "system_account", actor_id: account }]);
  expect(await restoreWorkflowVersion(tenant_id, id, 1, user, ctx.db)).not.toBeNull();
  const history = await listWorkflowVersions(tenant_id, id, {}, ctx.db);
  expect(history.rows.map((row) => row.author)).toEqual([
    null,
    { kind: "system_account", id: account },
    { kind: "user", id: user },
    { kind: "system_account", id: account },
    { kind: "user", id: user },
  ]);
  for (const row of history.rows) expect(row.checksum).toBe(workflowJsonDigest(row.dag));
  expect(history.rows[0]?.checksum).toBe(history.rows[4]?.checksum);
  expect(history.rows[1]?.checksum).toBe(history.rows[4]?.checksum);
  const foreign = await listWorkflowVersions(
    "10000000-0000-4000-8000-000000000003",
    id,
    {},
    ctx.db,
  );
  expect(foreign.rows).toEqual([]);
  const view = await getWorkflow(tenant_id, id, ctx.db);
  expect(view?.creator).toEqual({ kind: "user", id: user });
  expect(view?.checksum).toBe(history.rows[0]?.checksum);
  const listed = await listWorkflows(tenant_id, {}, ctx.db);
  expect(listed.rows.find((row) => row.id === id)?.creator).toEqual(view?.creator);
  expect(listed.rows.find((row) => row.id === id)?.checksum).toBe(view?.checksum);
  await ctx.db
    .update(workflows)
    .set({ current_version_id: null })
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id)));
  const withoutCurrent = await getWorkflow(tenant_id, id, ctx.db);
  expect(withoutCurrent?.creator).toEqual(view?.creator);
  expect(withoutCurrent?.checksum).toBeNull();
  await ctx.db
    .update(workflows)
    .set({ current_version_id: view?.current_version_id ?? null })
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id)));
  await ctx.db
    .delete(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.workflow_id, id),
        eq(workflowVersions.version, 1),
      ),
    );
  const withoutOriginal = await getWorkflow(tenant_id, id, ctx.db);
  expect(withoutOriginal?.creator).toBeNull();
  expect(withoutOriginal?.checksum).toBe(view?.checksum);
  expect(await getWorkflow("10000000-0000-4000-8000-000000000003", id, ctx.db)).toBeNull();
});

test("legacy workflow actor IDs remain unknown across create, update, drafts, metadata, and restore", async () => {
  const legacyDefinition = (variant: string) => ({
    ...definition(variant),
    name: "Legacy actor workflow",
    slug: "legacy-actor-workflow",
  });
  const created = await createWorkflow(
    { tenant_id, actor_id: account, def: legacyDefinition("initial") },
    ctx.db,
  );
  if (!created.workflow) throw new Error(created.errors.join("; "));
  const id = created.workflow.id;
  const updated = await updateWorkflow(
    { tenant_id, id, actor_id: account, def: legacyDefinition("updated") },
    ctx.db,
  );
  if (!updated.workflow) throw new Error(updated.errors.join("; "));
  const draft = await saveWorkflowDraft(
    {
      tenant_id,
      workflow_id: id,
      expected_draft_version_id: null,
      actor_id: account,
      request_source: "api",
      def: legacyDefinition("draft"),
      metadata: { description: "Legacy metadata update" },
    },
    ctx.db,
  );
  if (!draft.draft) throw new Error(draft.errors.join("; "));
  const metadata = await updateWorkflowMetadata(
    { tenant_id, id, actor_id: account, name: "Legacy renamed workflow" },
    ctx.db,
  );
  if (!metadata.workflow) throw new Error(metadata.errors.join("; "));
  expect(await restoreWorkflowVersion(tenant_id, id, 1, account, ctx.db)).not.toBeNull();

  const actions = [
    "workflow.created",
    "workflow.updated",
    "catalog_metadata.updated",
    "workflow.version_restored",
  ];
  const audits = await ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, id)));
  for (const action of actions) {
    expect(audits.filter((audit) => audit.action === action).length).toBeGreaterThan(0);
  }
  expect(audits.every((audit) => audit.actor_type === "unknown" && audit.actor_id === null)).toBe(
    true,
  );
});

test("workflow views preserve deleted connector reasons without exposing another tenant's records", async () => {
  const [foreignTenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "connector-ref-foreign", display_name: "Foreign" })
    .returning();
  if (!foreignTenant) throw new Error("test tenant missing");
  const [owned] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "removed-connector",
      display_name: "Removed connector",
      driver: "http",
      deleted_at: new Date("2000-01-01T00:00:00Z"),
    })
    .returning();
  const [foreign] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: foreignTenant.id,
      slug: "foreign-connector",
      display_name: "Private foreign name",
      driver: "http",
    })
    .returning();
  if (!owned || !foreign) throw new Error("connector fixtures missing");
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id,
      slug: "connector-ref-workflow",
      name: "Connector references",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow fixture missing");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: workflow.name,
        steps: [
          {
            kind: "request",
            id: "deleted",
            connector_id: owned.id,
            method: "GET",
            url: "https://example.test",
          },
          {
            kind: "request",
            id: "foreign",
            connector_id: foreign.id,
            method: "GET",
            url: "https://example.test",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("version fixture missing");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow.id)));
  const view = await getWorkflow(tenant_id, workflow.id, ctx.db);
  expect(view?.connector_references).toEqual([
    {
      step_id: "deleted",
      connector_id: owned.id,
      slug: owned.slug,
      name: owned.display_name,
      reason: "deleted",
    },
    { step_id: "foreign", connector_id: foreign.id, slug: null, name: null, reason: "missing" },
  ]);
  const listed = await listWorkflows(tenant_id, {}, ctx.db);
  expect(listed.rows.find((row) => row.id === workflow.id)?.connector_references).toEqual(
    view?.connector_references,
  );
});

test("operating filters apply before pagination and count the full matching set", async () => {
  const fixtures = [
    { slug: "operating-a", lifecycle: "draft" as const },
    { slug: "operating-b", lifecycle: "archived" as const },
    { slug: "operating-c", lifecycle: "draft" as const },
    { slug: "operating-d", lifecycle: "archived" as const },
  ];
  await ctx.db
    .insert(workflows)
    .values(fixtures.map((fixture) => ({ ...fixture, tenant_id, name: fixture.slug })));
  const first = await listWorkflows(
    tenant_id,
    { q: "operating-", operating_status: "disabled", sort: "name", order: "asc", limit: 1 },
    ctx.db,
  );
  const second = await listWorkflows(
    tenant_id,
    {
      q: "operating-",
      operating_status: "disabled",
      sort: "name",
      order: "asc",
      limit: 1,
      offset: 1,
    },
    ctx.db,
  );
  const exhausted = await listWorkflows(
    tenant_id,
    {
      q: "operating-",
      operating_status: "disabled",
      sort: "name",
      order: "asc",
      limit: 1,
      offset: 2,
    },
    ctx.db,
  );
  expect(first.total).toBe(2);
  expect(first.rows.map((row) => row.slug)).toEqual(["operating-b"]);
  expect(second.total).toBe(2);
  expect(second.rows.map((row) => row.slug)).toEqual(["operating-d"]);
  expect(exhausted.total).toBe(2);
  expect(exhausted.rows).toEqual([]);
  expect(first.rows[0]?.operating_status).toBe("disabled");
});
