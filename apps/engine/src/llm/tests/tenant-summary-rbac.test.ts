import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { connectors, tenants, users, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { catalogVisibility } from "../../rbac/evaluator.ts";
import { grantResource } from "../../rbac/grants.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import { listWorkflowToolSlugs } from "../../workflows/catalog.ts";
import {
  loadSnapshotCoverage,
  loadTenantSummary,
  renderTenantSummaryBlock,
  snapshotCoverage,
} from "../core/tenant-summary.ts";

let tdb: TestDb;
let tenant_id: string;
const workflowIds: Record<string, string> = {};
const connectorIds: Record<string, string> = {};
let admin: ResolvedPrincipal;
let enduser: ResolvedPrincipal;
let nobody: ResolvedPrincipal;

async function seedWorkflow(slug: string, category: string): Promise<string> {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({ tenant_id, slug, name: slug, lifecycle: "active", is_tool: true, category })
    .returning({ id: workflows.id });
  const [version] = await tdb.db
    .insert(workflowVersions)
    .values({ tenant_id, workflow_id: wf!.id, version: 1, dag: { name: slug, slug, steps: [] } })
    .returning({ id: workflowVersions.id });
  await tdb.db
    .update(workflows)
    .set({ current_version_id: version!.id })
    .where(eq(workflows.id, wf!.id));
  return wf!.id;
}

async function seedConnector(slug: string, environment: "dev" | "prod"): Promise<string> {
  const [row] = await tdb.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      environment,
      auth_type: "none",
      base_url: "https://example.test",
    })
    .returning({ id: connectors.id });
  return row!.id;
}

async function seedUser(email: string, role_id: string): Promise<string> {
  const [row] = await tdb.db
    .insert(users)
    .values({ tenant_id, email, role_id })
    .returning({ id: users.id });
  return row!.id;
}

beforeAll(async () => {
  tdb = await createTestDb("tenant-summary-rbac");
  const [tenant] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-summary-rbac", display_name: "Summary RBAC" })
    .returning();
  tenant_id = tenant!.id;

  workflowIds["alpha-sync"] = await seedWorkflow("alpha-sync", "sales");
  workflowIds["beta-report"] = await seedWorkflow("beta-report", "sales");
  workflowIds["gamma-cleanup"] = await seedWorkflow("gamma-cleanup", "ops");
  connectorIds.crm = await seedConnector("crm", "dev");
  connectorIds.mail = await seedConnector("mail", "prod");

  const adminId = await seedUser("admin@summary", await builtinRoleId(tdb.db, "admin"));
  const noPermissions = await emptyRoleId(tdb.db, tenant_id);
  const enduserId = await seedUser("enduser@summary", noPermissions);
  const nobodyId = await seedUser("nobody@summary", noPermissions);

  const base = (id: string, roles: string[]): ResolvedPrincipal => ({
    provider: "api_key",
    kind: "user",
    id,
    tenant_id,
    roles,
  });
  admin = base(adminId, ["admin"]);
  enduser = base(enduserId, []);
  nobody = base(nobodyId, []);

  await grantResource(tdb.db, {
    tenant_id,
    subject_type: "user",
    subject_id: enduserId,
    resource_type: "workflow",
    resource_id: workflowIds["alpha-sync"]!,
    permission: "workflow:read",
  });
  await grantResource(tdb.db, {
    tenant_id,
    subject_type: "user",
    subject_id: enduserId,
    resource_type: "connector",
    resource_id: connectorIds.crm!,
    permission: "connector:read",
  });
}, 60_000);

afterAll(async () => {
  await tdb.cleanup();
}, 30_000);

describe("tenant snapshot under RBAC", () => {
  test("an enduser with grants on 1 of 3 workflows and 1 of 2 connectors sees exactly those", async () => {
    const summary = await loadTenantSummary(enduser, tdb.db);
    expect(summary.workflows.map((w) => w.slug)).toEqual(["alpha-sync"]);
    expect(summary.connectors.map((c) => c.slug)).toEqual(["crm"]);
    expect(summary.workflows_total).toBe(1);
    expect(summary.connectors_total).toBe(1);
    expect(summary.workflow_categories).toEqual([{ category: "sales", count: 1 }]);

    const block = renderTenantSummaryBlock(summary, new Set(["alpha-sync"])) ?? "";
    expect(block).toContain("Workflows (1 total)");
    expect(block).toContain("Categories (exact counts over all 1): sales (1)");
    expect(block).toContain("alpha-sync");
    expect(block).toContain("Connectors (1 total)");
    expect(block).toContain("crm (http/dev)");
    for (const hidden of ["beta-report", "gamma-cleanup", "mail", "ops"]) {
      expect(block).not.toContain(hidden);
    }
  });

  test("admin sees the whole catalog with category counts over every row", async () => {
    const summary = await loadTenantSummary(admin, tdb.db);
    expect(summary.workflows.map((w) => w.slug)).toEqual([
      "alpha-sync",
      "beta-report",
      "gamma-cleanup",
    ]);
    expect(summary.connectors.map((c) => c.slug)).toEqual(["crm", "mail"]);
    expect(summary.workflows_total).toBe(3);
    expect(summary.connectors_total).toBe(2);
    expect(summary.workflow_categories).toEqual([
      { category: "sales", count: 2 },
      { category: "ops", count: 1 },
    ]);
  });

  test("allowed_workflows restricts an admin further and leaves connectors alone", async () => {
    const summary = await loadTenantSummary(
      { ...admin, allowed_workflows: [workflowIds["beta-report"]!] },
      tdb.db,
    );
    expect(summary.workflows.map((w) => w.slug)).toEqual(["beta-report"]);
    expect(summary.workflows_total).toBe(1);
    expect(summary.workflow_categories).toEqual([{ category: "sales", count: 1 }]);
    expect(summary.connectors_total).toBe(2);
  });

  test("a principal without any grant gets no snapshot at all", async () => {
    const summary = await loadTenantSummary(nobody, tdb.db);
    expect(summary.workflows).toEqual([]);
    expect(summary.connectors).toEqual([]);
    expect(summary.workflows_total).toBe(0);
    expect(summary.connectors_total).toBe(0);
    expect(renderTenantSummaryBlock(summary, new Set())).toBeNull();
  });

  test("loadSnapshotCoverage agrees with loadTenantSummary for every principal", async () => {
    for (const principal of [admin, enduser, nobody]) {
      const summary = await loadTenantSummary(principal, tdb.db);
      expect(await loadSnapshotCoverage(principal, tdb.db)).toEqual(snapshotCoverage(summary));
    }
  });

  test("every wf_ tool slug is visible and no snapshot name lies outside catalogVisibility", async () => {
    for (const principal of [admin, enduser]) {
      const [summary, toolSlugs, workflowVisible, connectorVisible] = await Promise.all([
        loadTenantSummary(principal, tdb.db),
        listWorkflowToolSlugs({ db: tdb.db, principal }),
        catalogVisibility(tdb.db, principal, "workflow:read", "workflow"),
        catalogVisibility(tdb.db, principal, "connector:read", "connector"),
      ]);
      const visibleSlugs = new Set(summary.workflows.map((w) => w.slug));
      expect(toolSlugs.size).toBeGreaterThan(0);
      for (const slug of toolSlugs) expect(visibleSlugs.has(slug)).toBe(true);
      for (const w of summary.workflows) expect(workflowVisible!(w.id)).toBe(true);
      for (const c of summary.connectors) expect(connectorVisible!(c.id)).toBe(true);
    }
    expect([...(await listWorkflowToolSlugs({ db: tdb.db, principal: enduser }))]).toEqual([
      "alpha-sync",
    ]);
    expect((await listWorkflowToolSlugs({ db: tdb.db, principal: nobody })).size).toBe(0);
  });
});
