// Integration tests for the loop→for_each boot backfill.
//
// `createTestDb` runs the full embedded migration set plus the item_var
// and loop→for_each backfills, so a fresh DB already carries both
// `data_migrations` markers. The tests below delete the
// LOOP_TO_FOR_EACH_BACKFILL_NAME marker, seed legacy workflow rows
// (direct inserts — historical versions predate validator rejection,
// exactly like production data), then re-run the backfill and assert:
//
//   - an eligible loop (single body, data_selector, no downstream ref)
//     is rotated to a new version with for_each on the body step;
//   - the loop step is removed from the migrated definition;
//   - an ineligible loop (multi-body) is left unchanged;
//   - workflows_schedules rows survive the rotate (PUT-unbinds-schedules
//     trap must not reappear here);
//   - an audit_log entry per migrated workflow;
//   - the second invocation is a no-op (idempotent via marker).

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
import {
  LOOP_TO_FOR_EACH_BACKFILL_NAME,
  runLoopToForEachBackfill,
} from "./loop-to-for-each-backfill.ts";

let ctx: TestDb;
let tenantId: string;

beforeAll(async () => {
  ctx = await createTestDb("loop_to_for_each_backfill");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-loop-migrate", display_name: "LoopMigrate" })
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

async function seedWorkflow(args: {
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

// An eligible loop: single body step + data_selector.
const eligibleDag = (extra?: Record<string, unknown>): Record<string, unknown> => ({
  name: "eligible-loop",
  steps: [
    { id: "fetch_data", kind: "request", method: "GET", url: "https://api.example.com/data" },
    {
      id: "iterate_rows",
      kind: "loop",
      data_selector: "(sourceData) => sourceData.fetch_data.data.rows",
      body: ["process_row"],
    },
    {
      id: "process_row",
      kind: "transform",
      language: "javascript",
      expression: "(input) => ({ id: input.$item.id })",
    },
  ],
  ...(extra ?? {}),
});

// An ineligible loop: multi-body steps.
const ineligibleDag = (): Record<string, unknown> => ({
  name: "multi-body-loop",
  steps: [
    { id: "fetch", kind: "request", method: "GET", url: "https://api.example.com/items" },
    {
      id: "iter",
      kind: "loop",
      data_selector: "(sourceData) => sourceData.fetch.data",
      body: ["step_a", "step_b"],
    },
    {
      id: "step_a",
      kind: "transform",
      language: "javascript",
      expression: "(input) => input.$item",
    },
    {
      id: "step_b",
      kind: "transform",
      language: "javascript",
      expression: "(input) => input.step_a",
    },
  ],
});

describe("loop→for_each backfill", () => {
  let eligible: SeededWorkflow;
  let ineligible: SeededWorkflow;

  test("seed: marker exists from createTestDb; delete it and seed legacy rows", async () => {
    const marker = await ctx.db
      .select()
      .from(dataMigrations)
      .where(eq(dataMigrations.name, LOOP_TO_FOR_EACH_BACKFILL_NAME));
    expect(marker).toHaveLength(1);
    await ctx.db
      .delete(dataMigrations)
      .where(eq(dataMigrations.name, LOOP_TO_FOR_EACH_BACKFILL_NAME));

    eligible = await seedWorkflow({
      slug: "eligible-loop-wf",
      dag: eligibleDag({
        trigger: { kind: "schedule", cron: "0 8 * * *", tz: "UTC" },
      }),
      schedule: { cron: "0 8 * * *" },
    });
    ineligible = await seedWorkflow({
      slug: "ineligible-loop-wf",
      dag: ineligibleDag(),
    });
  });

  test("backfill migrates the eligible workflow and leaves the ineligible one unchanged", async () => {
    const report = await runLoopToForEachBackfill(ctx.db);
    expect(report.skipped).toBe(false);
    expect(report.affected).toBe(1); // only the eligible one
    expect(report.migrated).toBe(1);
    expect(report.needs_review).toBe(0);

    // Eligible: two versions now.
    const eligibleVersions = await ctx.db
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, tenantId),
          eq(workflowVersions.workflow_id, eligible.workflow_id),
        ),
      )
      .orderBy(asc(workflowVersions.version));
    expect(eligibleVersions).toHaveLength(2);

    // Historical v1 unchanged.
    const v1dag = eligibleVersions[0]?.dag as { steps: Array<Record<string, unknown>> };
    expect(v1dag.steps.some((s) => s.id === "iterate_rows")).toBe(true);

    // New v2: loop step removed, body step has for_each.
    const v2dag = eligibleVersions[1]?.dag as { steps: Array<Record<string, unknown>> };
    expect(v2dag.steps.some((s) => s.id === "iterate_rows")).toBe(false);
    const processRow = v2dag.steps.find((s) => s.id === "process_row") as
      | { for_each?: string }
      | undefined;
    expect(processRow?.for_each).toBe("(sourceData) => sourceData.fetch_data.data.rows");

    // Current version pointer updated.
    const [wfRow] = await ctx.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, eligible.workflow_id));
    expect(wfRow?.current_version_id).toBe(eligibleVersions[1]?.id ?? "");

    // Ineligible: still one version.
    const ineligibleVersions = await ctx.db
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, tenantId),
          eq(workflowVersions.workflow_id, ineligible.workflow_id),
        ),
      );
    expect(ineligibleVersions).toHaveLength(1);
    const ineligibleDagOut = ineligibleVersions[0]?.dag as {
      steps: Array<Record<string, unknown>>;
    };
    expect(ineligibleDagOut.steps.some((s) => s.id === "iter")).toBe(true);
  });

  test("workflows_schedules row-count parity across the migration", async () => {
    const rows = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, tenantId),
          eq(workflowsSchedules.workflow_id, eligible.workflow_id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cron).toBe("0 8 * * *");
  });

  test("audit log entry carries the migration change set", async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, eligible.workflow_id)));
    const migrationRow = rows.find(
      (r) => (r.metadata as { kind?: string } | null)?.kind === "loop_to_for_each_migration",
    );
    expect(migrationRow).toBeDefined();
    const meta = migrationRow?.metadata as {
      from_version: number;
      changes: Array<{
        loop_step_id: string;
        body_step_id: string;
        for_each: string;
        selector_source: string;
      }>;
    };
    expect(meta.from_version).toBe(1);
    expect(meta.changes).toHaveLength(1);
    expect(meta.changes[0]!.loop_step_id).toBe("iterate_rows");
    expect(meta.changes[0]!.body_step_id).toBe("process_row");
    expect(meta.changes[0]!.selector_source).toBe("data_selector");
  });

  test("idempotent: second run is a marker no-op", async () => {
    const before = await ctx.db
      .select({ c: sql<number>`count(*)::int` })
      .from(workflowVersions)
      .where(eq(workflowVersions.tenant_id, tenantId));
    const report = await runLoopToForEachBackfill(ctx.db);
    expect(report.skipped).toBe(true);
    const after = await ctx.db
      .select({ c: sql<number>`count(*)::int` })
      .from(workflowVersions)
      .where(eq(workflowVersions.tenant_id, tenantId));
    expect(Number(after[0]?.c)).toBe(Number(before[0]?.c));
  });
});
