import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectors,
  executionSteps,
  executions,
  patchCandidates,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { loadExecutionOutcome } from "../execution/outcome.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import {
  noChangeDiff,
  reviewableDiff,
  seedPatchableWorkflow,
} from "../test-helpers/patch-candidates.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import {
  buildOperatorHealthDigest,
  collectFailureGroups,
  MAX_PENDING_PATCHES,
} from "./health-digest.ts";

let testDb: TestDb;
let tenant_id: string;
let workflow_id: string;

beforeAll(async () => {
  testDb = await createTestDb("operator_digest");
  const db = testDb.db;

  tenant_id = (await seedTenant(db, { slug: "t-digest", display_name: "Digest" })).id;

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
  await seedFailure({
    source_kind: "saved",
    request_source: "cli",
    step_key: "list",
    error: { code: "placeholder_unresolved", message: "unresolved placeholder for input org" },
  });
  await seedFailure({
    source_kind: "draft",
    request_source: "chat",
    step_key: "transform",
    error: { code: "transform_error", message: "JSONata error" },
    workflow: false,
  });

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
    const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id));

    expect(digest.all_clear).toBe(false);
    expect(digest.failure_groups.length).toBe(3);

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
    const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id));
    expect(digest.patch_candidates.open).toBe(1);
    expect(digest.patch_candidates.items[0]?.summary).toBe("Widen messages selector");
    expect(digest.headline.startsWith("Needs attention:")).toBe(true);
    expect(digest.rendered).toContain("[scheduled]");
    expect(digest.rendered).toContain("[authoring]");
  });

  test("a tenant with no failures or pending patches reports all-clear", async () => {
    const empty = await seedTenant(testDb.db, { slug: "t-digest-empty", display_name: "Empty" });
    const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(empty!.id));
    expect(digest.all_clear).toBe(true);
    expect(digest.failure_groups.length).toBe(0);
    expect(digest.patch_candidates.open).toBe(0);
    expect(digest.attention.items).toEqual([]);
    expect(digest.headline).toBe("All clear — nothing needs your attention.");
  });

  test("history and trends do not make a digest need attention; the attention list does", async () => {
    const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id));
    const ids = digest.attention.items.map((item) => item.id).sort();
    expect(ids).toEqual(
      [
        `workflow:${workflow_id}`,
        `workflow:${digest.patch_candidates.items[0]?.workflow_id}`,
      ].sort(),
    );
    expect(digest.headline).toBe("Needs attention: 2 items (1 failing, 1 to decide).");
    const lines = digest.rendered
      .split("\n")
      .filter((line) => /^- \[(stopped|failing|decide)\]/.test(line));
    expect(lines.length).toBe(digest.attention.items.length);
  });

  test("ranks a stuck proposed patch first, flags its age, and dates the item from it", async () => {
    const t = await seedTenant(testDb.db, { slug: "t-digest-stuck", display_name: "Stuck" });
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

    const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(t!.id));
    expect(digest.patch_candidates.open).toBe(2);
    const first = digest.patch_candidates.items[0];
    expect(first?.summary).toBe("Rename removed field");
    expect(first?.classification).toBe("unsafe");
    expect(first?.stuck).toBe(true);
    expect(first?.age_days).toBeGreaterThanOrEqual(5);
    expect(digest.patch_candidates.items[1]?.stuck).toBe(false);
    expect(digest.attention.items).toHaveLength(1);
    expect(digest.attention.items[0]?.counts.patches).toBe(2);
    expect(digest.attention.items[0]?.since).toBe(
      new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(digest.rendered).toContain("(2 fixes)");
  });

  test("every count reports the exact total when the backlog exceeds the item cap", async () => {
    const t = await seedTenant(testDb.db, { slug: "t-digest-backlog", display_name: "Backlog" });
    const wf = { id: (await seedPatchableWorkflow(testDb.db, t!.id, "bulk", "Bulk")).workflow_id };

    const now = getTestNow();
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
    await testDb.db.insert(patchCandidates).values({
      tenant_id: t!.id,
      workflow_id: wf.id,
      classification: "safe",
      status: "proposed",
      diff: noChangeDiff("Moves a field to itself"),
    });

    const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(t!.id));
    expect(digest.patch_candidates.open).toBe(backlog);
    expect(digest.patch_candidates.items.length).toBe(MAX_PENDING_PATCHES);
    expect(digest.attention.items[0]?.counts.patches).toBe(backlog);
    expect(digest.rendered).toContain(`(${backlog} fixes)`);
    expect(digest.rendered).not.toContain(`(${MAX_PENDING_PATCHES} fixes)`);
  });
});

describe("a failure no step carries", () => {
  test("the digest and the execution outcome name the same validation failure", async () => {
    const db = testDb.db;
    const [wf] = await db
      .insert(workflows)
      .values({ tenant_id, slug: "validated-report", name: "Validated", lifecycle: "active" })
      .returning();
    if (!wf) throw new Error("workflow fixture missing");
    const now = new Date(getTestNow());
    const [exec] = await db
      .insert(executions)
      .values({
        tenant_id,
        workflow_id: wf.id,
        status: "failed",
        request_source: "scheduler",
        execution_mode: "dev",
        failure: {
          step_id: null,
          error_code: "validation_failed",
          error_message: "validation_expression `ok` returned false",
        },
        created_at: now,
        started_at: now,
        finished_at: now,
      })
      .returning();
    if (!exec) throw new Error("execution fixture missing");
    await db.insert(executionSteps).values({
      tenant_id,
      execution_id: exec.id,
      step_key: "out",
      kind: "transform",
      status: "succeeded",
      started_at: now,
    });

    const outcome = await loadExecutionOutcome(tenant_id, exec, db);
    const groups = await collectFailureGroups(db, tenant_id, 24 * 365 * 10, now);
    const group = groups.find((g) => g.workflow_id === wf.id);
    expect(outcome.failed_step).toBeNull();
    expect(outcome.error_code).toBe("validation_failed");
    expect(group?.error_code).toBe(outcome.error_code);
    expect(group?.step_key).toBeNull();
  });
});
