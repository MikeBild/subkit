// item_var → $item boot backfill (integration).
//
// `createTestDb` runs the full embedded migration bundle PLUS the code
// backfill, so a fresh test database already carries the
// `data_migrations` marker. The tests below delete the marker, seed
// legacy workflow rows (direct inserts — historical versions predate
// the validator rejection, exactly like production data), then re-run
// the backfill and pin:
//
//   - a clean legacy definition is rotated to a new version with the
//     `$item` rewrite, item_var removed, audit diff recorded;
//   - `workflows_schedules` rows survive the rotate (row-count parity —
//     the PUT-unbinds-schedules trap must not reappear here);
//   - an unrewritable definition is left untouched and flagged
//     needs_review with an audit row;
//   - the run is idempotent: the second invocation is a marker no-op.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  auditLog,
  dataMigrations,
  tenants,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { ITEMVAR_BACKFILL_NAME, runItemvarBackfill } from "./itemvar-backfill.ts";

let ctx: TestDb;
let tenantId: string;

beforeAll(async () => {
  ctx = await createTestDb("itemvar_backfill");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-itemvar", display_name: "ItemvarBackfill" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

interface SeededWorkflow {
  workflow_id: string;
  version_id: string;
}

async function seedLegacyWorkflow(args: {
  slug: string;
  dag: Record<string, unknown>;
  schedule?: { cron: string };
}): Promise<SeededWorkflow> {
  const [wf] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: args.slug, name: args.slug, lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("workflow insert failed");
  const [v] = await ctx.db
    .insert(workflowVersions)
    .values({ tenant_id: tenantId, workflow_id: wf.id, version: 1, dag: args.dag })
    .returning();
  if (!v) throw new Error("version insert failed");
  await ctx.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));
  if (args.schedule) {
    await ctx.db.insert(workflowsSchedules).values({
      tenant_id: tenantId,
      workflow_id: wf.id,
      cron: args.schedule.cron,
      timezone: "UTC",
    });
  }
  return { workflow_id: wf.id, version_id: v.id };
}

const legacyDag = (extra?: Record<string, unknown>): Record<string, unknown> => ({
  name: "legacy-loop",
  steps: [
    { id: "get_numbers", kind: "transform", expression: "[1, 2, 3]" },
    { id: "iter", kind: "loop", over: "get_numbers.data", item_var: "num", body: ["double"] },
    { id: "double", kind: "transform", expression: "num * 2" },
  ],
  ...(extra ?? {}),
});

describe("itemvar backfill", () => {
  let migratable: SeededWorkflow;
  let unrewritable: SeededWorkflow;

  test("seed: marker exists from createTestDb; delete it and seed legacy rows", async () => {
    const marker = await ctx.db
      .select()
      .from(dataMigrations)
      .where(eq(dataMigrations.name, ITEMVAR_BACKFILL_NAME));
    expect(marker).toHaveLength(1);
    await ctx.db.delete(dataMigrations).where(eq(dataMigrations.name, ITEMVAR_BACKFILL_NAME));

    migratable = await seedLegacyWorkflow({
      slug: "legacy-migratable",
      dag: legacyDag({
        trigger: { kind: "schedule", cron: "0 7 * * *", tz: "UTC" },
      }),
      schedule: { cron: "0 7 * * *" },
    });
    unrewritable = await seedLegacyWorkflow({
      slug: "legacy-needs-review",
      dag: {
        name: "legacy-cross-scope",
        steps: [
          { id: "get", kind: "transform", expression: "[{ 'name': 'p', 'children': [1] }]" },
          { id: "outer", kind: "loop", over: "get.data", item_var: "p", body: ["inner"] },
          { id: "inner", kind: "loop", over: "p.children", item_var: "q", body: ["leaf"] },
          // Cross-scope reference to the OUTER loop's item — no
          // canonical $item rewrite exists.
          { id: "leaf", kind: "transform", expression: "p.name & ': ' & q" },
        ],
      },
    });
  });

  test("backfill rotates the migratable workflow to the $item contract", async () => {
    const report = await runItemvarBackfill(ctx.db);
    expect(report.skipped).toBe(false);
    expect(report.affected).toBe(2);
    expect(report.migrated).toBe(1);
    expect(report.needs_review).toBe(1);

    const versions = await ctx.db
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, tenantId),
          eq(workflowVersions.workflow_id, migratable.workflow_id),
        ),
      )
      .orderBy(asc(workflowVersions.version));
    expect(versions).toHaveLength(2);
    // Historical version is immutable.
    const v1dag = versions[0]?.dag as { steps: Array<Record<string, unknown>> };
    expect(v1dag.steps[1]?.item_var).toBe("num");
    expect(v1dag.steps[2]?.expression).toBe("num * 2");
    // New current version carries the rewrite, no item_var.
    const v2 = versions[1];
    const v2dag = v2?.dag as { steps: Array<Record<string, unknown>> };
    expect(v2dag.steps[1]?.item_var).toBeUndefined();
    expect(v2dag.steps[2]?.expression).toBe("$item * 2");
    expect(v2?.note).toContain("itemvar-migration");

    const [wfRow] = await ctx.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, migratable.workflow_id));
    expect(wfRow?.current_version_id).toBe(v2?.id ?? "");
  });

  test("workflows_schedules row-count parity across the migration", async () => {
    const rows = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, tenantId),
          eq(workflowsSchedules.workflow_id, migratable.workflow_id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cron).toBe("0 7 * * *");
  });

  test("audit row carries the before/after expression diff", async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, migratable.workflow_id)),
      );
    const migrationRow = rows.find(
      (r) => (r.metadata as { kind?: string } | null)?.kind === "itemvar_migration",
    );
    expect(migrationRow).toBeDefined();
    const metadata = migrationRow?.metadata as {
      from_version: number;
      changes: Array<{ step_id: string; field: string; before: string; after: string }>;
    };
    expect(metadata.from_version).toBe(1);
    expect(metadata.changes).toEqual([
      { step_id: "double", field: "expression", before: "num * 2", after: "$item * 2" },
    ]);
  });

  test("unrewritable workflow is untouched and flagged needs_review", async () => {
    const versions = await ctx.db
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, tenantId),
          eq(workflowVersions.workflow_id, unrewritable.workflow_id),
        ),
      );
    expect(versions).toHaveLength(1);
    const dag = versions[0]?.dag as { steps: Array<Record<string, unknown>> };
    expect(dag.steps[1]?.item_var).toBe("p");

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, unrewritable.workflow_id)),
      );
    const flagged = rows.find(
      (r) => (r.metadata as { kind?: string } | null)?.kind === "itemvar_migration_needs_review",
    );
    expect(flagged).toBeDefined();
    expect(flagged?.result).toBe("error");
    expect((flagged!.metadata as { reason?: string }).reason).toContain("OUTER loop");
  });

  test("idempotent: second run is a marker no-op (no new versions)", async () => {
    const before = await ctx.db
      .select({ c: sql<number>`count(*)::int` })
      .from(workflowVersions)
      .where(eq(workflowVersions.tenant_id, tenantId));
    const report = await runItemvarBackfill(ctx.db);
    expect(report.skipped).toBe(true);
    const after = await ctx.db
      .select({ c: sql<number>`count(*)::int` })
      .from(workflowVersions)
      .where(eq(workflowVersions.tenant_id, tenantId));
    expect(Number(after[0]?.c)).toBe(Number(before[0]?.c));
  });
});
