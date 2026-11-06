import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  tenants,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

let testDb: TestDb;
let tenant_id: string;
let workflow_id: string;
let version_id: string;
const actor = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  testDb = await createTestDb("authority_open_ended");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-authority-open-ended", display_name: "open ended" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenant_id = tenant.id;
  const [workflow] = await testDb.db
    .insert(workflows)
    .values({ tenant_id, slug: "open-ended", name: "open ended", lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("seed workflow failed");
  workflow_id = workflow.id;
  const [version] = await testDb.db
    .insert(workflowVersions)
    .values({ tenant_id, workflow_id, version: 1, dag: { name: "open ended", steps: [] } })
    .returning();
  if (!version) throw new Error("seed version failed");
  version_id = version.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

async function grant(values: Partial<typeof workflowExecutionAuthorities.$inferInsert> = {}) {
  const [row] = await testDb.db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id,
      workflow_id,
      workflow_version_id: version_id,
      effect_manifest_digest: "0".repeat(64),
      effect_manifest: {},
      execution_environment: "prod",
      target_constraints: { targets: [] },
      valid_until: null,
      max_runs: null,
      created_by: actor,
      ...values,
    })
    .returning();
  if (!row) throw new Error("grant insert failed");
  return row;
}

async function update(
  id: string,
  values: Partial<typeof workflowExecutionAuthorities.$inferInsert>,
): Promise<void> {
  await testDb.db
    .update(workflowExecutionAuthorities)
    .set(values)
    .where(eq(workflowExecutionAuthorities.id, id));
}

describe("workflow authority open-ended inheritance", () => {
  test("an approval may have neither end date nor run limit, and still counts runs", async () => {
    const row = await grant();
    expect(row).toMatchObject({ valid_until: null, max_runs: null, reserved_runs: 0 });
    await update(row.id, { reserved_runs: 20_000 });
  });

  test("a limited approval keeps its limit", async () => {
    const row = await grant({ max_runs: 1 });
    await expect(update(row.id, { reserved_runs: 2 })).rejects.toThrow();
  });

  test("continued at most once; the parent link and approved boundary are immutable", async () => {
    const parent = await grant();
    const child = await grant({ inherited_from: parent.id, approved_manifest: { a: 1 } });
    await expect(grant({ inherited_from: parent.id })).rejects.toThrow();
    await expect(update(child.id, { inherited_from: null })).rejects.toThrow();
    await expect(update(child.id, { approved_manifest: { a: 2 } })).rejects.toThrow();
  });

  test("an approval is superseded only by ending it, without a person, and stays ended", async () => {
    const parent = await grant();
    const child = await grant({ inherited_from: parent.id });
    await expect(update(parent.id, { superseded_by: child.id })).rejects.toThrow();
    await update(parent.id, {
      superseded_by: child.id,
      revoked_at: sql`clock_timestamp()` as unknown as Date,
    });
    await expect(update(parent.id, { reserved_runs: 1 })).rejects.toThrow();
    const lone = await grant();
    await expect(
      update(lone.id, { revoked_at: sql`clock_timestamp()` as unknown as Date }),
    ).rejects.toThrow();
  });
});
