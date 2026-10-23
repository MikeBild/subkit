import { afterAll, beforeAll, expect, test } from "bun:test";
import { tenants, users } from "../../apps/engine/src/db/schema/index.ts";
import { createTestDb, type TestDb } from "../../apps/engine/src/db/tests/setup.ts";
import { builtinRoleId } from "../../apps/engine/src/rbac/roles.ts";
import { previewWorkflowAuthority } from "../../apps/engine/src/workflows/execution-authorities.ts";
import {
  cockpitDemoId,
  cockpitDemoOwnerEmail,
  cockpitDemoOwnerName,
  cockpitDemoOwnerSql,
  cockpitDemoSetupTenantName,
  cockpitDemoTenantName,
  cockpitDemoTenantSlug,
  createCockpitDemoApprovalSql,
  createCockpitDemoCatalogRepairSql,
  createCockpitDemoSeedSql,
  demoAiRuns,
  demoApprovedWorkflow,
  demoMonthlyBudgetTokens,
  demoTemplateConnectors,
} from "./cockpit-demo-seed.ts";

let context: TestDb;
let tenantId: string;
let adminId: string;
type ArchiveRow = {
  after: { status?: string } | null;
  actor_type: string;
  actor_exists: boolean;
  current_status: string;
  source_created_at: Date;
  source_updated_at: Date;
  ts: Date;
  metadata: {
    origin_source?: string;
    request_source?: string;
    audit_credential_origin?: string;
    audit_trace_id?: string;
    execution_id?: string;
  };
  credential_exists: boolean;
  credential_owner_id: string | null;
  conversation_exists: boolean;
  conversation_owner_id: string | null;
  actor_id: string | null;
};

beforeAll(async () => {
  context = await createTestDb("cockpit_demo_seed");
  const [tenant] = await context.db
    .insert(tenants)
    .values({
      slug: cockpitDemoTenantSlug,
      display_name: cockpitDemoSetupTenantName,
    })
    .returning();
  if (!tenant) throw new Error("missing test tenant");
  tenantId = tenant.id;
  const [admin] = await context.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: "demo-owner@localhost.test",
      role_id: await builtinRoleId(context.db, "admin"),
    })
    .returning();
  if (!admin) throw new Error("missing test admin");
  adminId = admin.id;
}, 60_000);

afterAll(async () => {
  if (context) await context.cleanup();
}, 30_000);

test("archive audit story has valid persisted status, actor, credential, conversation and time relations", async () => {
  await context.pool.query(createCockpitDemoSeedSql(tenantId, adminId));
  const sourceId = cockpitDemoId(tenantId, "knowledge-0");
  const result = await context.pool.query(
    `SELECT a.id::text, a.action, a.result, a.actor_type, a.actor_id::text,
            a.ts, a.before, a.after, a.metadata,
            k.status::text AS current_status, k.created_at AS source_created_at,
            k.updated_at AS source_updated_at,
            u.id IS NOT NULL AS actor_exists,
            key.id IS NOT NULL AS credential_exists,
            key.user_id::text AS credential_owner_id,
            c.id IS NOT NULL AS conversation_exists,
            c.owner_id::text AS conversation_owner_id
       FROM audit_log a
       JOIN knowledge_sources k ON k.id::text=a.resource_id AND k.tenant_id=a.tenant_id
       LEFT JOIN users u ON u.id=a.actor_id AND u.tenant_id=a.tenant_id
       LEFT JOIN api_keys key ON key.id::text=a.metadata->>'audit_used_api_key_id'
                             AND key.tenant_id=a.tenant_id
       LEFT JOIN conversations c ON c.id::text=a.metadata->>'conversation_id'
                                AND c.tenant_id=a.tenant_id
      WHERE a.tenant_id=$1 AND a.resource_type='knowledge_source' AND a.resource_id=$2
      ORDER BY a.ts`,
    [tenantId, sourceId],
  );
  expect(result.rows).toHaveLength(7);
  const rows = result.rows as ArchiveRow[];
  expect(rows.map((row) => row.after?.status ?? null)).toEqual([
    "processing",
    "active",
    "inactive",
    null,
    "active",
    null,
    null,
  ]);
  expect(rows.every((row) => row.current_status === "active")).toBe(true);
  expect(rows.filter((row) => row.actor_type === "user").every((row) => row.actor_exists)).toBe(
    true,
  );
  expect(rows[0]?.source_created_at.getTime()).toBe(rows[0]?.ts.getTime());
  expect(rows[0]?.source_updated_at.getTime()).toBe(rows[4]?.ts.getTime());
  expect(rows[2]?.metadata.origin_source).toBe("api");
  expect(rows[2]?.metadata.request_source).toBe("api");
  expect(rows[2]?.metadata.audit_credential_origin).toBe("cli_oauth_session");
  expect(rows[2]?.credential_exists).toBe(true);
  expect(rows[2]?.credential_owner_id).toBe(rows[2]?.actor_id);
  expect(rows[3]?.credential_exists).toBe(true);
  expect(rows[0]?.metadata.audit_trace_id).toBe(rows[1]?.metadata.audit_trace_id);
  expect(rows[2]?.metadata.audit_trace_id).toBe(rows[3]?.metadata.audit_trace_id);
  expect(rows[4]?.conversation_exists).toBe(true);
  expect(rows[4]?.conversation_owner_id).toBe(rows[4]?.actor_id);
  expect(rows[5]?.conversation_exists).toBe(true);
  expect(rows[4]?.metadata.audit_trace_id).toBe(rows[5]?.metadata.audit_trace_id);
  expect(rows.every((row) => row.metadata.execution_id === undefined)).toBe(true);
  const versions = await context.pool.query(
    "SELECT version, author_user_id::text, created_at FROM knowledge_source_versions WHERE tenant_id=$1 AND knowledge_source_id=$2",
    [tenantId, sourceId],
  );
  expect(versions.rows).toHaveLength(1);
  expect(versions.rows[0]?.author_user_id).toBe(adminId);
  expect(versions.rows[0]?.author_user_id).toBe(rows[0]?.actor_id);
  expect(versions.rows[0]?.created_at.getTime()).toBe(rows[1]?.ts.getTime());
}, 60_000);

test("seed presents the demo tenant and owner as a fictional customer and keeps the owner lookup", async () => {
  await context.pool.query(createCockpitDemoSeedSql(tenantId, adminId));
  const tenant = await context.pool.query("SELECT display_name FROM tenants WHERE id=$1", [
    tenantId,
  ]);
  expect(tenant.rows[0]?.display_name).toBe(cockpitDemoTenantName);
  const owner = await context.pool.query("SELECT email, display_name FROM users WHERE id=$1", [
    adminId,
  ]);
  expect(owner.rows[0]).toEqual({
    email: cockpitDemoOwnerEmail,
    display_name: cockpitDemoOwnerName,
  });
  const lookup = await context.pool.query(
    `SELECT t.id::text AS tenant_id, u.id::text AS user_id FROM tenants t JOIN users u ON u.tenant_id=t.id ${cockpitDemoOwnerSql} LIMIT 1`,
  );
  expect(lookup.rows).toEqual([{ tenant_id: tenantId, user_id: adminId }]);
  const people = await context.pool.query(
    "SELECT email FROM users WHERE tenant_id=$1 ORDER BY email",
    [tenantId],
  );
  expect(people.rows.every((row) => /@brennwerk\.(example|test)$/.test(String(row.email)))).toBe(
    true,
  );
}, 60_000);

test("demo brand assets satisfy the branding image rules and apply once per content", async () => {
  const { normalizeBrandingAppIcon, normalizeBrandingImage } = await import(
    "../../apps/engine/src/files/branding-image.ts"
  );
  const { applyCockpitDemoBranding, cockpitDemoBrandingUpdate, cockpitDemoBrandingDigest } =
    await import("./cockpit-demo-branding.ts");
  const update = cockpitDemoBrandingUpdate(3);
  expect(update.display_name).toBe("Brennwerk");
  expect(update.subtitle).toBe("Logistik");
  expect(update.palette).toBe("teal");
  for (const logo of [update.logos.light, update.logos.dark]) {
    expect(Buffer.from(logo.content_base64, "base64").length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect((await normalizeBrandingImage(logo)).length).toBeGreaterThan(0);
  }
  expect(Buffer.from(update.app_icon.content_base64, "base64").length).toBeLessThanOrEqual(
    2 * 1024 * 1024,
  );
  const icons = await normalizeBrandingAppIcon(update.app_icon);
  expect(icons.icon_512.length).toBeGreaterThan(0);

  const calls: string[][] = [];
  const request = async (path: string, method = "GET") => {
    calls.push([method, path]);
    return { revision: 3 };
  };
  const digest = await applyCockpitDemoBranding(request, undefined);
  expect(digest).toBe(cockpitDemoBrandingDigest());
  expect(calls).toEqual([
    ["GET", "/v1/tenant/branding"],
    ["PUT", "/v1/tenant/branding"],
  ]);
  expect(await applyCockpitDemoBranding(request, digest)).toBe(digest);
  expect(calls).toHaveLength(2);
});

test("seed shows every feature: intake from AI, template connectors, an AI step and usage outliers", async () => {
  await context.pool.query(createCockpitDemoSeedSql(tenantId, adminId));
  const intake = await context.pool.query(
    "SELECT original_snapshot->>'origin' AS origin, state::text, original_snapshot->>'source_url' AS url FROM intake_items WHERE tenant_id=$1",
    [tenantId],
  );
  const origins = intake.rows.map((row) => row.origin).sort();
  expect(origins).toEqual([
    "capture",
    "capture",
    "capture",
    "note",
    "session",
    "session",
    "session",
  ]);
  const agents = await context.pool.query(
    `SELECT i.original_snapshot->>'client' AS client, i.original_snapshot->>'agent' AS agent, i.original_snapshot->>'session_id' AS session,
            e.agent AS evidence_agent, c.id IS NOT NULL AS conversation
       FROM intake_items i
       JOIN intake_item_evidence e ON e.item_id=i.id AND e.tenant_id=i.tenant_id
       LEFT JOIN conversations c ON c.id::text=i.original_snapshot->>'session_id' AND c.tenant_id=i.tenant_id
      WHERE i.tenant_id=$1 AND i.original_snapshot->>'origin'='session' ORDER BY 1`,
    [tenantId],
  );
  expect(
    agents.rows.map((row) => [row.client, row.agent, row.evidence_agent, row.conversation]),
  ).toEqual([
    ["chat", "save_learning", "save_learning", true],
    ["claude-code", "claude-code", "claude-code", false],
    ["codex", "codex", "codex", false],
  ]);
  expect(intake.rows.every((row) => row.state === "collected")).toBe(true);
  expect(intake.rows.filter((row) => row.origin === "capture").every((row) => row.url)).toBe(true);
  const connectors = await context.pool.query(
    "SELECT slug, template_slug, base_url FROM connectors WHERE tenant_id=$1 AND template_slug IS NOT NULL ORDER BY slug",
    [tenantId],
  );
  expect(connectors.rows.map((row) => row.template_slug).sort()).toEqual(
    demoTemplateConnectors.map((connector) => connector.template).sort(),
  );
  expect(
    connectors.rows.every((row) =>
      /^(https:\/\/[a-z.-]+\.invalid|http:\/\/demo-api:8080)(\/|$)/.test(String(row.base_url)),
    ),
  ).toBe(true);
  const ai = await context.pool.query(
    `SELECT v.dag FROM workflows w JOIN workflow_versions v ON v.id=w.current_version_id WHERE w.tenant_id=$1 AND w.id=$2`,
    [tenantId, cockpitDemoId(tenantId, "workflow-ai")],
  );
  const steps = ai.rows[0]?.dag.steps as { connector_id?: string }[];
  expect(
    steps.some((step) => step.connector_id === cockpitDemoId(tenantId, "connector-openai")),
  ).toBe(true);
  const perRun = await context.pool.query(
    `SELECT (e.started_at > now() - interval '3 days') AS recent, avg(u.total_tokens)::int AS tokens
       FROM llm_usage u JOIN executions e ON e.id=u.execution_id
      WHERE u.tenant_id=$1 AND e.workflow_id=$2 GROUP BY 1 ORDER BY 1`,
    [tenantId, cockpitDemoId(tenantId, "workflow-ai")],
  );
  expect(perRun.rows.map((row) => row.tokens)).toEqual([4000, 12000]);
  const unpriced = await context.pool.query(
    "SELECT count(*)::int AS n FROM llm_usage WHERE tenant_id=$1 AND model='mistral-medium-3'",
    [tenantId],
  );
  expect(unpriced.rows[0]?.n).toBe(3);
  const automatic = await context.pool.query(
    "SELECT count(*)::int AS n FROM llm_usage WHERE tenant_id=$1 AND user_id IS NULL",
    [tenantId],
  );
  expect(automatic.rows[0]?.n).toBeGreaterThan(0);
  const versions = await context.pool.query(
    "SELECT version FROM knowledge_source_versions WHERE tenant_id=$1 AND knowledge_source_id=$2 ORDER BY version",
    [tenantId, cockpitDemoId(tenantId, "knowledge-1")],
  );
  expect(versions.rows.map((row) => row.version)).toEqual([1, 2, 3]);
  for (const table of ["workflows", "connectors", "knowledge_sources", "skills"]) {
    const leaked = await context.pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1 AND (description LIKE 'Mock description:%' OR category IN ('mock-category','sk'))`,
      [tenantId],
    );
    expect(leaked.rows[0]?.n).toBe(0);
  }
}, 60_000);

test("platform files and starter workflows lose mock catalog text after the platform seed", async () => {
  const sourceId = cockpitDemoId(tenantId, "platform-source-fixture");
  const fileId = cockpitDemoId(tenantId, "platform-file-fixture");
  const workflowId = cockpitDemoId(tenantId, "starter-workflow-fixture");
  await context.pool.query(
    `INSERT INTO knowledge_sources (id, tenant_id, name, slug, source_type, source_uri, version, status, description, category, description_source, category_source)
     VALUES ($1,$2,'Webhooks','sk-ref-webhooks','text','text:sk-ref-webhooks','1','active','How inbound webhooks work.','platform','human','human')`,
    [sourceId, tenantId],
  );
  await context.pool.query(
    `INSERT INTO files (id, tenant_id, status, filename, content_type, size_bytes, storage_uri, description, category, description_source, category_source)
     VALUES ($1,$2,'ready','sk-ref-webhooks.md','text/markdown',10,'s3://demo/x','Mock description: You catalogue one file','sk','llm','llm')`,
    [fileId, tenantId],
  );
  await context.pool.query(
    `INSERT INTO workflows (id, tenant_id, slug, name, lifecycle, description, category, description_source, category_source)
     VALUES ($1,$2,'demo-httpbin-echo','Echo','active','Mock description: You catalogue one workflow','mock-category','llm','llm')`,
    [workflowId, tenantId],
  );
  await context.pool.query(
    "INSERT INTO catalog_categories (tenant_id,name) VALUES ($1,'mock-category'),($1,'sk') ON CONFLICT DO NOTHING",
    [tenantId],
  );
  try {
    await context.pool.query(createCockpitDemoCatalogRepairSql(tenantId));
    const file = await context.pool.query(
      "SELECT description, category, description_source, category_source FROM files WHERE id=$1",
      [fileId],
    );
    expect(file.rows[0]).toEqual({
      description: "How inbound webhooks work.",
      category: "platform",
      description_source: "human",
      category_source: "human",
    });
    const workflow = await context.pool.query(
      "SELECT description, category FROM workflows WHERE id=$1",
      [workflowId],
    );
    expect(workflow.rows[0]?.category).toBe("demo");
    expect(String(workflow.rows[0]?.description)).not.toContain("Mock");
    const categories = await context.pool.query(
      "SELECT name FROM catalog_categories WHERE tenant_id=$1 AND name IN ('mock-category','sk')",
      [tenantId],
    );
    expect(categories.rows).toEqual([]);
  } finally {
    await context.pool.query("DELETE FROM files WHERE id=$1", [fileId]);
    await context.pool.query("DELETE FROM workflows WHERE id=$1", [workflowId]);
    await context.pool.query("DELETE FROM knowledge_sources WHERE id=$1", [sourceId]);
  }
}, 60_000);

test("the AI workflow's runs and the budget forecast are anchored to now", () => {
  const now = new Date(2026, 9, 23, 12);
  const runs = demoAiRuns(now);
  expect(runs.filter((run) => run.key.startsWith("ai-run-now"))).toHaveLength(3);
  for (const run of runs.filter((r) => r.key.startsWith("ai-run-before")))
    expect(now.getTime() - run.startedAt.getTime()).toBeGreaterThan(7 * 86_400_000);
  const budget = demoMonthlyBudgetTokens({ usedTokens: 100_000, lastSevenDaysTokens: 70_000, now });
  expect(budget).not.toBeNull();
  const remainingDays = (new Date(2026, 10, 1).getTime() - now.getTime()) / 86_400_000;
  expect(budget as number).toBeGreaterThan(100_000);
  expect(budget as number).toBeLessThan(100_000 + 10_000 * remainingDays);
  expect(demoMonthlyBudgetTokens({ usedTokens: 1, lastSevenDaysTokens: 0, now })).toBeNull();
});

test("one workflow carries an open-ended production approval for its read and write effects", async () => {
  await context.pool.query(createCockpitDemoSeedSql(tenantId, adminId));
  const workflowId = cockpitDemoId(tenantId, demoApprovedWorkflow.key);
  const versionId = cockpitDemoId(tenantId, demoApprovedWorkflow.versionKey);
  const authorityId = cockpitDemoId(tenantId, demoApprovedWorkflow.authorityKey);
  const boundary = {
    tenant_id: tenantId,
    workflow_id: workflowId,
    workflow_version_id: versionId,
    execution_environment: "prod" as const,
  };
  const preview = await previewWorkflowAuthority(boundary, context.db);
  expect(preview.eligible_for_repeated_runs).toBe(true);
  expect(preview.manifest.effects.map((effect) => effect.effect).sort()).toEqual(["read", "write"]);
  const approval = createCockpitDemoApprovalSql(tenantId, adminId, preview);
  await context.pool.query(approval);
  await context.pool.query(approval);
  const authorities = await context.pool.query(
    `SELECT id::text, workflow_version_id::text, execution_environment::text, effect_manifest_digest,
            valid_from, valid_until, max_runs, revoked_at, created_by::text, target_constraints
       FROM workflow_execution_authorities WHERE tenant_id=$1 AND workflow_id=$2`,
    [tenantId, workflowId],
  );
  expect(authorities.rows).toHaveLength(1);
  const authority = authorities.rows[0];
  expect(authority).toMatchObject({
    id: authorityId,
    workflow_version_id: versionId,
    execution_environment: "prod",
    valid_until: null,
    max_runs: null,
    revoked_at: null,
    created_by: adminId,
    target_constraints: { targets: ["http://demo-api:8080/echo", "http://demo-api:8080/report"] },
  });
  expect(authority?.valid_from.getTime()).toBeLessThan(Date.now());
  const fresh = await previewWorkflowAuthority(boundary, context.db);
  expect(authority?.effect_manifest_digest).toBe(fresh.digest);
  const workflow = await context.pool.query(
    "SELECT lifecycle, current_version_id::text FROM workflows WHERE tenant_id=$1 AND id=$2",
    [tenantId, workflowId],
  );
  expect(workflow.rows[0]).toEqual({ lifecycle: "active", current_version_id: versionId });
  const audit = await context.pool.query(
    "SELECT action, actor_id::text, result, metadata FROM audit_log WHERE tenant_id=$1 AND resource_type='workflow_execution_authority' AND resource_id=$2",
    [tenantId, authorityId],
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    action: "workflow.authority_granted",
    actor_id: adminId,
    result: "success",
    metadata: {
      execution_environment: "prod",
      open_ended: true,
      valid_until: null,
      max_runs: null,
    },
  });
}, 60_000);

test("the approval refuses a preview of another workflow or an ineligible boundary", () => {
  const manifest = {
    workflow_id: cockpitDemoId(tenantId, demoApprovedWorkflow.key),
    workflow_version_id: cockpitDemoId(tenantId, demoApprovedWorkflow.versionKey),
    execution_environment: "prod",
    effects: [],
  };
  const digest = "a".repeat(64);
  expect(() =>
    createCockpitDemoApprovalSql(tenantId, adminId, {
      manifest: { ...manifest, workflow_id: cockpitDemoId(tenantId, "workflow-3") },
      digest,
      eligible_for_repeated_runs: true,
    }),
  ).toThrow();
  expect(() =>
    createCockpitDemoApprovalSql(tenantId, adminId, {
      manifest,
      digest,
      eligible_for_repeated_runs: false,
    }),
  ).toThrow();
  expect(() =>
    createCockpitDemoApprovalSql(tenantId, adminId, {
      manifest: { ...manifest, execution_environment: "dev" },
      digest,
      eligible_for_repeated_runs: true,
    }),
  ).toThrow();
});

test("scheduled demo runs carry the scheduler source, also after a repair of an older seed", async () => {
  await context.pool.query(createCockpitDemoSeedSql(tenantId, adminId));
  const [first] = demoAiRuns(new Date());
  if (!first) throw new Error("missing demo run");
  const runId = cockpitDemoId(tenantId, first.key);
  await context.pool.query("UPDATE executions SET request_source='schedule' WHERE id=$1", [runId]);
  await context.pool.query(createCockpitDemoSeedSql(tenantId, adminId));
  const sources = await context.pool.query(
    "SELECT DISTINCT request_source FROM executions WHERE tenant_id=$1 AND workflow_id=$2",
    [tenantId, cockpitDemoId(tenantId, "workflow-ai")],
  );
  expect(sources.rows).toEqual([{ request_source: "scheduler" }]);
}, 60_000);
