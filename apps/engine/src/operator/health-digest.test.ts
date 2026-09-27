// Operator health digest — grouping, origin tagging, and the
// open-patch-decision bucket. Seeds failed executions from three origins and
// asserts they collapse by root-cause signature and tag correctly.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectors,
  executionSteps,
  executions,
  patchCandidates,
  tenants,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import {
  noChangeDiff,
  reviewableDiff,
  seedPatchableWorkflow,
} from "../test-helpers/patch-candidates.ts";
import { buildOperatorHealthDigest, MAX_PENDING_PATCHES } from "./health-digest.ts";

let testDb: TestDb;
let tenant_id: string;
let workflow_id: string;

beforeAll(async () => {
  testDb = await createTestDb("operator_digest");
  const db = testDb.db;

  const [tenant] = await db
    .insert(tenants)
    .values({ slug: "t-digest", display_name: "Digest" })
    .returning();
  tenant_id = tenant!.id;

  const [wf] = await db
    .insert(workflows)
    .values({ tenant_id, slug: "daily-report", name: "Daily Report", lifecycle: "active" })
    .returning();
  workflow_id = wf!.id;

  const [ver] = await db
    .insert(workflowVersions)
    .values({ tenant_id, workflow_id, version: 1, dag: { name: "Daily Report", steps: [] } })
    .returning();

  const [conn] = await db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "gmail",
      display_name: "Gmail",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://gmail.test",
      config: {},
    })
    .returning();

  // Helper to seed a failed execution + a failed step.
  async function seedFailure(args: {
    source_kind: string;
    request_source: string;
    step_key: string;
    error: Record<string, unknown>;
    workflow?: boolean;
  }) {
    const [exec] = await db
      .insert(executions)
      .values({
        tenant_id,
        workflow_id: args.workflow === false ? null : workflow_id,
        workflow_version_id: args.workflow === false ? null : ver!.id,
        source_kind: args.source_kind,
        source_ref: args.workflow === false ? { name: "Draft Run" } : null,
        status: "failed",
        request_source: args.request_source,
        execution_mode: "dev",
      })
      .returning();
    await db.insert(executionSteps).values({
      tenant_id,
      execution_id: exec!.id,
      step_key: args.step_key,
      step_index: 0,
      kind: "request",
      status: "failed",
      error: args.error,
    });
  }

  // Two scheduled failures with the SAME signature → one group, count 2.
  await seedFailure({
    source_kind: "saved",
    request_source: "scheduler",
    step_key: "fetch",
    error: { code: "http_4xx", message: "http 404", guidance: "The path is wrong." },
  });
  await seedFailure({
    source_kind: "saved",
    request_source: "scheduler",
    step_key: "fetch",
    error: { code: "http_4xx", message: "http 404", guidance: "The path is wrong." },
  });
  // A manual test run missing an input → separate group, manual origin.
  await seedFailure({
    source_kind: "saved",
    request_source: "cli",
    step_key: "list",
    error: { code: "placeholder_unresolved", message: "unresolved placeholder for input org" },
  });
  // An authoring draft trial-run → authoring origin.
  await seedFailure({
    source_kind: "draft",
    request_source: "chat",
    step_key: "transform",
    error: { code: "transform_error", message: "JSONata error" },
    workflow: false,
  });

  // One open patch decision — proposed and reviewable on the current version.
  const patchable = await seedPatchableWorkflow(db, tenant_id, "messages-sync");
  await db.insert(patchCandidates).values({
    tenant_id,
    workflow_id: patchable.workflow_id,
    connector_id: conn!.id,
    endpoint_key: "GET /messages",
    classification: "safe",
    status: "proposed",
    diff: reviewableDiff("Widen messages selector"),
  });
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("buildOperatorHealthDigest", () => {
  test("groups by root-cause signature and tags origin", async () => {
    const digest = await buildOperatorHealthDigest(testDb.db, tenant_id);

    expect(digest.all_clear).toBe(false);
    expect(digest.failure_groups.length).toBe(3); // scheduled(2), manual(1), authoring(1)

    const scheduled = digest.failure_groups.find((g) => g.error_code === "http_4xx");
    expect(scheduled?.origin).toBe("scheduled");
    expect(scheduled?.count).toBe(2);
    expect(scheduled?.workflow_name).toBe("Daily Report");
    expect(scheduled?.guidance).toBe("The path is wrong.");

    const manual = digest.failure_groups.find((g) => g.error_code === "placeholder_unresolved");
    expect(manual?.origin).toBe("manual");
    expect(manual?.cause).toContain("placeholder");

    const authoring = digest.failure_groups.find((g) => g.error_code === "transform_error");
    expect(authoring?.origin).toBe("authoring");
    expect(authoring?.workflow_name).toBe("Draft Run");
  });

  test("surfaces open patch decisions and an outcome-first headline", async () => {
    const digest = await buildOperatorHealthDigest(testDb.db, tenant_id);
    expect(digest.patch_candidates.open).toBe(1);
    expect(digest.patch_candidates.items[0]?.summary).toBe("Widen messages selector");
    expect(digest.headline.startsWith("Needs attention:")).toBe(true);
    expect(digest.rendered).toContain("[scheduled]");
    expect(digest.rendered).toContain("[authoring]");
  });

  test("a tenant with no failures or pending patches reports all-clear", async () => {
    const [empty] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-digest-empty", display_name: "Empty" })
      .returning();
    const digest = await buildOperatorHealthDigest(testDb.db, empty!.id);
    expect(digest.all_clear).toBe(true);
    expect(digest.failure_groups.length).toBe(0);
    expect(digest.patch_candidates.open).toBe(0);
    expect(digest.headline).toContain("healthy");
  });

  test("ranks a stuck proposed patch first, flags its age, and calls it out in the headline", async () => {
    const [t] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-digest-stuck", display_name: "Stuck" })
      .returning();
    const wf = { id: (await seedPatchableWorkflow(testDb.db, t!.id, "sync", "Sync")).workflow_id };
    const [conn] = await testDb.db
      .insert(connectors)
      .values({
        tenant_id: t!.id,
        slug: "api",
        display_name: "API",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://api.test",
        config: {},
      })
      .returning();

    const now = getTestNow();
    // A fresh safe patch and an old unsafe patch. The old one must surface
    // first even though it was inserted first (older created_at) and is the
    // one the operator has been unknowingly ignoring.
    await testDb.db.insert(patchCandidates).values([
      {
        tenant_id: t!.id,
        workflow_id: wf!.id,
        connector_id: conn!.id,
        endpoint_key: "POST /",
        classification: "unsafe",
        status: "proposed",
        created_at: new Date(now - 5 * 24 * 60 * 60 * 1000),
        diff: reviewableDiff("Rename removed field"),
      },
      {
        tenant_id: t!.id,
        workflow_id: wf!.id,
        connector_id: conn!.id,
        endpoint_key: "GET /x",
        classification: "safe",
        status: "proposed",
        created_at: new Date(now - 1 * 60 * 60 * 1000),
        diff: reviewableDiff("Fresh fix"),
      },
    ]);

    const digest = await buildOperatorHealthDigest(testDb.db, t!.id, { audit: false });
    expect(digest.patch_candidates.open).toBe(2);
    const first = digest.patch_candidates.items[0];
    expect(first?.summary).toBe("Rename removed field");
    expect(first?.classification).toBe("unsafe");
    expect(first?.stuck).toBe(true);
    expect(first?.age_days).toBeGreaterThanOrEqual(5);
    expect(digest.patch_candidates.items[1]?.stuck).toBe(false);
    expect(digest.headline).toContain("stuck");
    expect(digest.rendered).toContain("stuck 5d");
  });

  test("every count reports the exact total when the backlog exceeds the item cap", async () => {
    const [t] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-digest-backlog", display_name: "Backlog" })
      .returning();
    const wf = { id: (await seedPatchableWorkflow(testDb.db, t!.id, "bulk", "Bulk")).workflow_id };

    const now = getTestNow();
    // 60 open decisions against a cap of 50. The headline, the rendered
    // block and `open` must all say 60 — the headline used to count the capped
    // list and said 50 while `pending` said 60.
    const backlog = 60;
    expect(backlog).toBeGreaterThan(MAX_PENDING_PATCHES);
    await testDb.db.insert(patchCandidates).values(
      Array.from({ length: backlog }, (_, i) => ({
        tenant_id: t!.id,
        workflow_id: wf.id,
        classification: "safe" as const,
        status: "proposed" as const,
        created_at: new Date(now - i * 60_000),
        diff: reviewableDiff(`Fix ${i}`),
      })),
    );
    // Undecidable rows are not open and must not be counted anywhere.
    await testDb.db.insert(patchCandidates).values({
      tenant_id: t!.id,
      workflow_id: wf.id,
      classification: "safe",
      status: "proposed",
      diff: noChangeDiff("Moves a field to itself"),
    });

    const digest = await buildOperatorHealthDigest(testDb.db, t!.id, { audit: false });
    expect(digest.patch_candidates.open).toBe(backlog);
    expect(digest.patch_candidates.items.length).toBe(MAX_PENDING_PATCHES);
    expect(digest.headline).toContain(`${backlog} fixes awaiting review`);
    expect(digest.headline).not.toContain(`${MAX_PENDING_PATCHES} fixes`);
    expect(digest.rendered).toContain(`${backlog} self-healing fixes awaiting review:`);
    expect(digest.rendered).toContain(`(+${backlog - MAX_PENDING_PATCHES} more)`);
  });
});
