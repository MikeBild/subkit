import { afterAll, beforeAll, expect, test } from "bun:test";

import { runMigrations } from "../../db/migrate.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { saveWorkflowDraft } from "../drafts.ts";

let ctx: TestDb;
let tenantId = "";
let otherTenantId = "";
const actorId = "00000000-0000-4000-8000-000000000001";
type Boundary = { tenantId: string; workflowId: string; versionId: string };

beforeAll(async () => {
  ctx = await createTestDb("execution_authority_schema");
  const rows = await ctx.db
    .insert(tenants)
    .values([
      { slug: "authority-owner", display_name: "Authority owner" },
      { slug: "authority-other", display_name: "Authority other" },
    ])
    .returning();
  tenantId = rows.find((row) => row.slug === "authority-owner")?.id ?? "";
  otherTenantId = rows.find((row) => row.slug === "authority-other")?.id ?? "";
  if (!tenantId || !otherTenantId) throw new Error("missing fixture tenants");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function version(slug: string, owner = tenantId): Promise<Boundary> {
  const result = await saveWorkflowDraft(
    {
      tenant_id: owner,
      actor_id: null,
      request_source: "api",
      def: {
        name: slug,
        slug,
        steps: [{ id: "result", kind: "transform", expression: "return 1;" }],
      },
    },
    ctx.db,
  );
  if (!result.draft) throw new Error(result.errors.join("; "));
  return {
    tenantId: owner,
    workflowId: result.draft.workflow_id,
    versionId: result.draft.version_id,
  };
}

// Storage fixtures are not authorization-service calls and grant no product API.
async function insertAuthority(
  boundary: Boundary,
  patch: Record<string, unknown> = {},
): Promise<string> {
  const values = {
    digest: "a".repeat(64),
    manifest: { schema_version: 1 },
    environment: "dev",
    targets: { targets: ["https://example.test/reviewed-target"] },
    maxRuns: 1,
    reservedRuns: 0,
    validFrom: null,
    validUntil: null,
    ...patch,
  };
  const result = await ctx.pool.query<{ id: string }>(
    `INSERT INTO subkit.workflow_execution_authorities
       (tenant_id, workflow_id, workflow_version_id, effect_manifest_digest, effect_manifest,
        execution_environment, target_constraints, max_runs, reserved_runs, valid_from, valid_until, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
       COALESCE($10::timestamptz,clock_timestamp()-interval '1 second'),
       COALESCE($11::timestamptz,clock_timestamp()+interval '1 hour'),$12)
     RETURNING id`,
    [
      boundary.tenantId,
      boundary.workflowId,
      boundary.versionId,
      values.digest,
      JSON.stringify(values.manifest),
      values.environment,
      JSON.stringify(values.targets),
      values.maxRuns,
      values.reservedRuns,
      values.validFrom,
      values.validUntil,
      actorId,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("missing authority fixture");
  return id;
}

test("new workflow drafts receive no execution authority implicitly", async () => {
  const boundary = await version("no-implicit-authority");
  const result = await ctx.pool.query(
    "SELECT id FROM subkit.workflow_execution_authorities WHERE tenant_id=$1 AND workflow_id=$2",
    [boundary.tenantId, boundary.workflowId],
  );
  expect(result.rows).toHaveLength(0);
});

test("upgrading an active legacy workflow preserves its version and grants no execution authority", async () => {
  const legacy = await createTestDb("authority_upgrade", { upToIdx: 50 });
  try {
    const owner = await legacy.pool.query<{ id: string }>(
      "INSERT INTO subkit.tenants (slug,display_name) VALUES ('legacy-authority','Legacy authority') RETURNING id",
    );
    const ownerId = owner.rows[0]?.id;
    if (!ownerId) throw new Error("missing legacy tenant");
    const workflow = await legacy.pool.query<{ id: string }>(
      "INSERT INTO subkit.workflows (tenant_id,slug,name,lifecycle) VALUES ($1,'legacy-active','Legacy active','active') RETURNING id",
      [ownerId],
    );
    const workflowId = workflow.rows[0]?.id;
    const versionRow = await legacy.pool.query<{ id: string }>(
      "INSERT INTO subkit.workflow_versions (tenant_id,workflow_id,version,dag) VALUES ($1,$2,1,$3) RETURNING id",
      [ownerId, workflowId, JSON.stringify({ name: "Legacy active", steps: [] })],
    );
    const versionId = versionRow.rows[0]?.id;
    await legacy.pool.query(
      "UPDATE subkit.workflows SET current_version_id=$3 WHERE tenant_id=$1 AND id=$2",
      [ownerId, workflowId, versionId],
    );
    await runMigrations(legacy.db);
    await runMigrations(legacy.db);
    const preserved = await legacy.pool.query(
      "SELECT lifecycle,current_version_id,draft_version_id FROM subkit.workflows WHERE tenant_id=$1 AND id=$2",
      [ownerId, workflowId],
    );
    expect(preserved.rows).toEqual([
      { lifecycle: "active", current_version_id: versionId, draft_version_id: null },
    ]);
    const grants = await legacy.pool.query(
      "SELECT id FROM subkit.workflow_execution_authorities WHERE tenant_id=$1",
      [ownerId],
    );
    expect(grants.rows).toHaveLength(0);
  } finally {
    await legacy.cleanup();
  }
});

test("database binds authority to the exact tenant, workflow and version", async () => {
  const own = await version("exact-owner");
  const neighbor = await version("exact-neighbor");
  const other = await version("exact-other", otherTenantId);
  for (const mismatch of [
    { ...own, tenantId: otherTenantId },
    { ...own, versionId: neighbor.versionId },
    { ...own, versionId: other.versionId },
    { ...own, workflowId: other.workflowId },
  ]) {
    await expect(insertAuthority(mismatch)).rejects.toMatchObject({ code: "23503" });
  }
  expect(await insertAuthority(own)).toBeString();
});

test("invalid digests, unbounded runs, invalid windows and malformed manifests fail at storage", async () => {
  const boundary = await version("invalid-boundaries");
  for (const patch of [
    { digest: "unknown" },
    { maxRuns: 0 },
    { reservedRuns: -1 },
    { reservedRuns: 2 },
    { manifest: [] },
    { targets: [] },
    { targets: {} },
    { targets: { targets: null } },
    { validFrom: "2030-01-02T00:00:00Z", validUntil: "2030-01-01T00:00:00Z" },
  ]) {
    await expect(insertAuthority(boundary, patch)).rejects.toMatchObject({ code: "23514" });
  }
});

test("approved boundaries cannot be extended or retargeted in place", async () => {
  const boundary = await version("immutable-boundaries");
  const id = await insertAuthority(boundary);
  for (const change of [
    "max_runs=max_runs+1",
    "valid_until=valid_until+interval '1 hour'",
    "valid_from=valid_from-interval '1 hour'",
    "execution_environment='prod'",
    "effect_manifest_digest=repeat('b',64)",
    "effect_manifest='{}'::jsonb",
    "target_constraints='{\"targets\":[]}'::jsonb",
    "created_at=created_at+interval '1 second'",
  ]) {
    await expect(
      ctx.pool.query(
        `UPDATE subkit.workflow_execution_authorities SET ${change} WHERE tenant_id=$1 AND id=$2`,
        [boundary.tenantId, id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }
});

test("parallel reservations cannot exceed the last available run or reset consumption", async () => {
  const boundary = await version("parallel-last-run");
  const id = await insertAuthority(boundary);
  const reserve = () =>
    ctx.pool.query(
      "UPDATE subkit.workflow_execution_authorities SET reserved_runs=reserved_runs+1 WHERE tenant_id=$1 AND id=$2 RETURNING reserved_runs",
      [boundary.tenantId, id],
    );
  const attempts = await Promise.allSettled([reserve(), reserve()]);
  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason.code).toBe("23514");
  await expect(
    ctx.pool.query(
      "UPDATE subkit.workflow_execution_authorities SET reserved_runs=0 WHERE tenant_id=$1 AND id=$2",
      [boundary.tenantId, id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

test("expiry, future windows and revocation prevent reservations", async () => {
  const boundary = await version("terminal-boundaries");
  for (const patch of [
    { validFrom: "2000-01-01T00:00:00Z", validUntil: "2000-01-02T00:00:00Z" },
    { validFrom: "2100-01-01T00:00:00Z", validUntil: "2100-01-02T00:00:00Z" },
  ]) {
    const id = await insertAuthority(boundary, patch);
    await expect(
      ctx.pool.query(
        "UPDATE subkit.workflow_execution_authorities SET reserved_runs=1 WHERE tenant_id=$1 AND id=$2",
        [boundary.tenantId, id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }
  const id = await insertAuthority(boundary);
  await ctx.pool.query(
    "UPDATE subkit.workflow_execution_authorities SET revoked_at=clock_timestamp(), revoked_by=$3 WHERE tenant_id=$1 AND id=$2",
    [boundary.tenantId, id, actorId],
  );
  for (const change of [
    "revoked_at=NULL, revoked_by=NULL",
    "reserved_runs=1",
    "revoked_at=revoked_at+interval '1 second'",
  ]) {
    await expect(
      ctx.pool.query(
        `UPDATE subkit.workflow_execution_authorities SET ${change} WHERE tenant_id=$1 AND id=$2`,
        [boundary.tenantId, id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }
});

test("a referenced workflow definition stays immutable while preview metadata can refresh", async () => {
  const boundary = await version("bound-version");
  await insertAuthority(boundary);
  await expect(
    ctx.pool.query(
      "UPDATE subkit.workflow_versions SET dag='{}'::jsonb WHERE tenant_id=$1 AND id=$2",
      [boundary.tenantId, boundary.versionId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await ctx.pool.query(
    "UPDATE subkit.workflow_versions SET scope_index='{}'::jsonb WHERE tenant_id=$1 AND id=$2",
    [boundary.tenantId, boundary.versionId],
  );
});
